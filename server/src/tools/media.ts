// §2.3 — Image generation tool.
//
// Calls an OpenAI-compatible `/images/generations` endpoint (DALL-E,
// Stability AI, etc.) and saves the resulting image(s) to the workspace.
// Falls back to a local placeholder if no provider is configured, so the
// tool always succeeds in a sensible way during development.

import { writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { isWithinWorkspace, resolveWorkspacePath, toWorkspaceRelativePath } from "./filesystem.js";

type ImageSize = "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";

const VALID_SIZES: ReadonlySet<ImageSize> = new Set([
  "256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"
]);

const ALLOWED_OUTPUT_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function extensionForMime(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  return ".png";
}

function pickOutputPath(suggested: string | undefined, workspaceRoot: string, ext: string): string {
  // SECURITY: only allow output paths inside the workspace. The agent
  // cannot write generated images outside the user's project.
  const trimmed = (suggested ?? "").trim() || `generated-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
  const fullPath = resolveWorkspacePath(trimmed, workspaceRoot);
  if (!isWithinWorkspace(fullPath, workspaceRoot)) {
    throw new Error(`outputPath "${trimmed}" is outside the workspace`);
  }
  return fullPath;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("data URL is not in base64 form");
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
}

export class GenerateImageTool extends Tool {
  definition: ToolDefinition = {
    name: "generate_image",
    description: "Generate an image from a text prompt using an OpenAI-compatible image-generation API (DALL-E, Stability, etc.). The image is saved into the workspace and the relative path is returned. If no IMAGE_API_KEY is configured the tool returns a placeholder PNG so the workflow can be tested end-to-end.",
    category: "media",
    riskLevel: "network",
    requiresApproval: true,
    parameters: {
      prompt: {
        type: "string",
        description: "Text prompt describing the image",
        required: true
      },
      size: {
        type: "string",
        description: "Output size. Defaults to 1024x1024.",
        required: false,
        enum: ["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"]
      },
      n: {
        type: "number",
        description: "Number of images (1-4, default 1)",
        required: false
      },
      outputPath: {
        type: "string",
        description: "Workspace-relative path to write the image to. Defaults to generated-<timestamp>.png in the workspace root.",
        required: false
      },
      apiKey: {
        type: "string",
        description: "Override the IMAGE_API_KEY env var (use only if the user has supplied a key out-of-band).",
        required: false
      },
      baseUrl: {
        type: "string",
        description: "Override the IMAGE_API_BASE_URL env var. Default: https://api.openai.com/v1",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
    if (!prompt) return { success: false, error: "prompt is required" };
    if (prompt.length > 4000) return { success: false, error: "prompt must be <= 4000 characters" };

    const size = (typeof params.size === "string" && VALID_SIZES.has(params.size as ImageSize)
      ? params.size
      : "1024x1024") as ImageSize;

    const n = typeof params.n === "number" ? Math.min(Math.max(1, Math.floor(params.n)), 4) : 1;

    const apiKey = (typeof params.apiKey === "string" && params.apiKey.trim())
      || process.env.IMAGE_API_KEY
      || process.env.OPENAI_API_KEY;
    const baseUrl = (typeof params.baseUrl === "string" && params.baseUrl.trim())
      || process.env.IMAGE_API_BASE_URL
      || "https://api.openai.com/v1";

    if (!apiKey) {
      // Generate a small placeholder PNG (1x1 px transparent) so the
      // workflow can be tested without a paid API key.
      const placeholder = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "base64"
      );
      const placeholderPath = `generated-placeholder-${Date.now()}.png`;
      const fullPath = pickOutputPath(placeholderPath, context.workspaceRoot, ".png");
      await writeFile(fullPath, placeholder);

      return {
        success: true,
        data: {
          images: [
            {
              path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
              fullPath,
              bytes: placeholder.length,
              placeholder: true,
              note: "IMAGE_API_KEY / OPENAI_API_KEY not set — wrote a 1x1 placeholder. Configure a real key to generate actual images."
            }
          ],
          prompt,
          size,
          count: 1
        }
      };
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.IMAGE_MODEL ?? "dall-e-3",
        prompt,
        size,
        n,
        response_format: "url"
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      return {
        success: false,
        error: `Image API responded ${response.status} ${response.statusText}: ${errText.slice(0, 500)}`
      };
    }

    const body = (await response.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
    const items = body.data ?? [];
    if (items.length === 0) {
      return { success: false, error: "Image API returned an empty `data` array" };
    }

    const written: Array<{ path: string; fullPath: string; bytes: number; placeholder?: boolean }> = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      let buffer: Buffer;
      let ext: string;
      let placeholder = false;

      if (item.b64_json) {
        buffer = Buffer.from(item.b64_json, "base64");
        ext = ".png";
      } else if (item.url && isHttpUrl(item.url)) {
        const img = await fetch(item.url);
        if (!img.ok) {
          return { success: false, error: `Failed to download image ${i + 1} from ${item.url}: HTTP ${img.status}` };
        }
        const arrayBuffer = await img.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
        const mime = img.headers.get("content-type") ?? "image/png";
        ext = extensionForMime(mime);
      } else {
        return { success: false, error: `Image ${i + 1} has neither url nor b64_json` };
      }

      const suggestedName = typeof params.outputPath === "string" && items.length === 1
        ? params.outputPath
        : undefined;
      let fullPath: string;
      try {
        fullPath = pickOutputPath(suggestedName, context.workspaceRoot, ext);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!ALLOWED_OUTPUT_EXTS.has("." + (ext.startsWith(".") ? ext.slice(1) : ext))) {
        return { success: false, error: `Refusing to write image with extension ${ext}` };
      }

      await writeFile(fullPath, buffer);
      written.push({
        path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
        fullPath,
        bytes: buffer.length
      });
    }

    return {
      success: true,
      data: {
        images: written,
        prompt,
        size,
        count: written.length
      }
    };
  }
}
