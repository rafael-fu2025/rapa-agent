// Web tools for fetching and searching

import { Tool, type ToolDefinition, type ToolResult, type ToolExecutionContext } from "../lib/tools.js";
import { Suggest } from "../lib/suggestions.js";
import { prisma, getLocalUser } from "../lib/db.js";
import { decryptText } from "../lib/crypto.js";

// Maximum characters to return in raw body before truncation
const FETCH_URL_MAX_CHARS = 80_000;
// Maximum characters sent to the LLM for processing
const LLM_CONTENT_MAX_CHARS = 60_000;

/**
 * Lightweight HTML-to-text converter. Strips tags, decodes entities, collapses
 * whitespace, and preserves basic structure (headings become ALL-CAPS lines,
 * list items get a bullet prefix, links keep their href in parens).
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove <script>, <style>, <noscript> blocks entirely
  text = text.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Preserve link hrefs: <a href="URL">text</a> → text (URL)
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href, linkText) => {
    const clean = linkText.replace(/<[^>]+>/g, "").trim();
    return href && href !== "#" ? `${clean} (${href})` : clean;
  });

  // Headings → ALL-CAPS with newlines
  text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_match, content) => {
    return `\n\n## ${content.replace(/<[^>]+>/g, "").trim().toUpperCase()}\n\n`;
  });

  // List items → bullet prefix
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, content) => {
    return `\n- ${content.replace(/<[^>]+>/g, "").trim()}`;
  });

  // Paragraphs and line breaks → double/triple newlines
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»");

  // Collapse whitespace (but preserve intentional newlines)
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/**
 * Truncate a string to maxChars, appending a notice if truncated.
 */
function truncateContent(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false };
  return {
    text: content.slice(0, maxChars) + `\n\n[Content truncated at ${maxChars} characters — ${content.length - maxChars} characters omitted]`,
    truncated: true
  };
}

/**
 * Use the agent's LLM to process fetched content with a user-provided prompt.
 * Makes an OpenAI-compatible chat completion call.
 */
async function processWithLlm(
  content: string,
  prompt: string,
  url: string,
  llm: NonNullable<ToolExecutionContext["llm"]>
): Promise<{ processed: string; model: string }> {
  const truncated = truncateContent(content, LLM_CONTENT_MAX_CHARS);

  const systemMessage = `You are a content processing assistant. You have been given web content fetched from a URL. Process the content according to the user's prompt. Be concise and focused. If the content is irrelevant to the prompt, say so.`;

  const userMessage = `URL: ${url}\n\nPrompt: ${prompt}\n\n--- Fetched Content ---\n${truncated.text}\n--- End Content${truncated.truncated ? " (truncated)" : ""} ---`;

  const response = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${llm.apiKey}`
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`LLM processing failed (${response.status}): ${errText}`);
  }

  const result = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
  };

  const processed = result.choices?.[0]?.message?.content ?? "";
  return { processed, model: result.model ?? llm.model };
}

export class FetchUrlTool extends Tool {
  definition: ToolDefinition = {
    name: "fetch_url",
    description: "Fetch content from a URL with optional AI-powered processing. When a prompt is provided, the fetched content is processed by the LLM to extract, summarize, or answer questions about the page.",
    category: "web",
    riskLevel: "read",
    parameters: {
      url: {
        type: "string",
        description: "The URL to fetch",
        required: true
      },
      method: {
        type: "string",
        description: "HTTP method (GET, POST, etc.)",
        required: false,
        enum: ["GET", "POST", "PUT", "DELETE", "PATCH"]
      },
      headers: {
        type: "object",
        description: "HTTP headers to send",
        required: false
      },
      body: {
        type: "string",
        description: "Request body (for POST/PUT/PATCH)",
        required: false
      },
      prompt: {
        type: "string",
        description: "Optional prompt for AI processing of the fetched content (e.g. 'Summarize this page' or 'Extract all API endpoints'). When provided, the content is sent to the LLM along with this prompt.",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const url = params.url as string;
    const method = (params.method as string) ?? "GET";
    const headers = (params.headers as Record<string, string>) ?? {};
    const body = params.body as string | undefined;
    const prompt = (params.prompt as string | undefined)?.trim() || undefined;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? body : undefined
      });

      // 4xx/5xx — surface the body in the error, with a recovery hint.
      if (response.status >= 400) {
        const errBody = await response.text().catch(() => response.statusText);
        const truncatedBody = errBody.length > 1500 ? `${errBody.slice(0, 1500)}…` : errBody;
        const baseResult: ToolResult = {
          success: false,
          error: `HTTP ${response.status} ${response.statusText || ""} from ${url}\n\n${truncatedBody}`,
          data: { status: response.status, statusText: response.statusText, body: truncatedBody }
        };
        if (response.status === 401 || response.status === 403) {
          return Suggest.httpForbidden(baseResult, url);
        }
        if (response.status === 429) {
          return Suggest.httpRateLimit(baseResult, url);
        }
        if (response.status === 404) {
          return Suggest.generic(
            baseResult,
            "Verify the URL is correct. If the path was a guess, search the web for the resource or use a known-good base URL."
          );
        }
        return baseResult;
      }

      const contentType = response.headers.get("content-type") ?? "";
      let rawData: unknown;
      let rawText: string;

      if (contentType.includes("application/json")) {
        rawData = await response.json();
        rawText = typeof rawData === "string" ? rawData : JSON.stringify(rawData, null, 2);
      } else {
        rawText = await response.text();
        rawData = rawText;
      }

      // Convert HTML to clean text for LLM consumption
      const isHtml = contentType.includes("text/html") || /<html[\s>]/i.test(rawText.slice(0, 500));
      const cleanText = isHtml ? htmlToText(rawText) : rawText;

      // Truncate raw content for the response
      const truncatedRaw = truncateContent(cleanText, FETCH_URL_MAX_CHARS);

      const resultData: Record<string, unknown> = {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: truncatedRaw.text,
        contentLength: cleanText.length,
        truncated: truncatedRaw.truncated,
        converted: isHtml
      };

      // AI-powered content processing when prompt is provided
      if (prompt && context.llm) {
        try {
          const { processed, model } = await processWithLlm(cleanText, prompt, url, context.llm);
          resultData.processedContent = processed;
          resultData.processingModel = model;
          resultData.prompt = prompt;
        } catch (llmError) {
          resultData.processingError = llmError instanceof Error ? llmError.message : "LLM processing failed";
          resultData.processedContent = null;
        }
      } else if (prompt && !context.llm) {
        resultData.processingError = "LLM context not available — cannot process with AI. The raw content is still available in the body field.";
        resultData.processedContent = null;
      }

      return { success: true, data: resultData };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch URL"
      };
    }
  }
}

export class WebSearchTool extends Tool {
  definition: ToolDefinition = {
    name: "web_search",
    description: "Search the web for information using Serper API or DuckDuckGo fallback. When searching for 'latest' or 'current' info, ALWAYS include the current year in your search query string.",
    category: "web",
    riskLevel: "read",
    parameters: {
      query: {
        type: "string",
        description: "Search query",
        required: true
      },
      limit: {
        type: "number",
        description: "Maximum number of results (default: 5, max: 10)",
        required: false
      }
    }
  };

  private decodeHtml(value: string) {
    return value
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  /** Resolve the best available Serper API key.
   * Priority: env var → DB active key. */
  private async resolveSerperKey(): Promise<{ apiKey: string; keyId?: string } | null> {
    const envKey = process.env.SEARCH_API_KEY;
    if (envKey) return { apiKey: envKey };

    const secret = process.env.APP_SECRET;
    if (!secret) return null;

    try {
      const user = await getLocalUser();
      const key = await prisma.serviceApiKey.findFirst({
        where: { userId: user.id, service: "serper", isActive: true },
      });
      if (!key) return null;
      return { apiKey: decryptText(key.apiKeyEncrypted, secret), keyId: key.id };
    } catch {
      return null;
    }
  }

  /** If auto-switch is on, try the next key and promote it to active. */
  private async tryAutoSwitch(failedKeyId: string): Promise<{ apiKey: string; keyId: string } | null> {
    const secret = process.env.APP_SECRET;
    if (!secret) return null;

    try {
      const user = await getLocalUser();
      const failedKey = await prisma.serviceApiKey.findFirst({ where: { id: failedKeyId, userId: user.id } });
      if (!failedKey?.autoSwitch) return null;

      const nextKey = await prisma.serviceApiKey.findFirst({
        where: { userId: user.id, service: "serper", id: { not: failedKeyId } },
        orderBy: { createdAt: "asc" },
      });
      if (!nextKey) return null;

      await prisma.serviceApiKey.updateMany({ where: { userId: user.id, service: "serper" }, data: { isActive: false } });
      await prisma.serviceApiKey.update({ where: { id: nextKey.id }, data: { isActive: true } });

      return { apiKey: decryptText(nextKey.apiKeyEncrypted, secret), keyId: nextKey.id };
    } catch {
      return null;
    }
  }

  private async runSerperSearch(apiKey: string, keyId: string | undefined, query: string, limit: number): Promise<ToolResult | null> {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({ q: query, num: limit })
    });

    if ((response.status === 401 || response.status === 429) && keyId) {
      const switched = await this.tryAutoSwitch(keyId);
      if (switched) return this.runSerperSearch(switched.apiKey, switched.keyId, query, limit);
    }

    if (!response.ok) {
      const details = await response.text().catch(() => response.statusText);
      return { success: false, error: `Serper search failed: ${details || response.statusText}` };
    }

    const data = await response.json() as {
      organic?: Array<{ title?: string; link?: string; snippet?: string }>;
      knowledgeGraph?: Record<string, unknown>;
      answerBox?: Record<string, unknown>;
    };

    const results = (data.organic ?? [])
      .slice(0, limit)
      .map((item, index) => ({ rank: index + 1, title: item.title ?? "Untitled", url: item.link ?? "", snippet: item.snippet ?? "" }))
      .filter((item) => item.url.length > 0);

    return { success: true, data: { provider: "serper", query, results, knowledgeGraph: data.knowledgeGraph, answerBox: data.answerBox } };
  }

  private async runDuckDuckGoSearch(query: string, limit: number): Promise<ToolResult> {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; RapaAgent/1.0)" } });

    if (!response.ok) {
      const details = await response.text().catch(() => response.statusText);
      return { success: false, error: `DuckDuckGo search failed: ${details || response.statusText}` };
    }

    const html = await response.text();
    const resultRegex = /<a[^>]+class=\"result__a\"[^>]+href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class=\"result__snippet\"[^>]*>([\s\S]*?)<\/a>/gi;
    const results: Array<{ rank: number; title: string; url: string; snippet: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = resultRegex.exec(html)) !== null && results.length < limit) {
      const href = this.decodeHtml(match[1] ?? "").trim();
      const titleRaw = (match[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const snippetRaw = (match[3] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!href) continue;
      results.push({ rank: results.length + 1, title: this.decodeHtml(titleRaw) || "Untitled", url: href, snippet: this.decodeHtml(snippetRaw) });
    }

    return { success: true, data: { provider: "duckduckgo", query, results } };
  }

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    let query = (params.query as string).trim();
    const requestedLimit = Number(params.limit ?? 5);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(10, Math.floor(requestedLimit))) : 5;

    if (!query) return { success: false, error: "Search query is required" };

    // Force current year into the query to override LLM training bias
    const lowerQuery = query.toLowerCase();
    const currentYear = new Date().getFullYear().toString();
    if (lowerQuery.includes("latest") || lowerQuery.includes("newest") || lowerQuery.includes("current")) {
      // Remove trailing years that the LLM might have guessed
      query = query.replace(/\b(2023|2024|2025)\b/g, "").trim();
      if (!query.includes(currentYear)) {
        query = `${query} ${currentYear}`;
      }
    }

    try {
      const resolved = await this.resolveSerperKey();
      if (resolved) {
        const result = await this.runSerperSearch(resolved.apiKey, resolved.keyId, query, limit);
        if (result) return result;
      }
      return await this.runDuckDuckGoSearch(query, limit);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Web search failed" };
    }
  }
}
