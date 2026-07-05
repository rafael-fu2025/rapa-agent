// §2.1 — Browser automation tools.
//
// Provides 5 tools that work with a managed Playwright browser instance:
//   - browser_navigate   open a URL
//   - browser_read       get the page's text/HTML/screenshot
//   - browser_click      click a CSS selector
//   - browser_type       type text into a field
//   - browser_evaluate   run JS in the page context
//
// Playwright is loaded lazily so the module is importable even when the
// package isn't installed. If the import fails, every tool returns a
// clear "install playwright" error so the user knows what to do.

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { isWithinWorkspace, resolveWorkspacePath, toWorkspaceRelativePath } from "./filesystem.js";

const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const SCREENSHOTS_DIR = ".browser-screenshots";

// --- Playwright loader (lazy, optional) ------------------------------------

type PlaywrightModule = typeof import("playwright");
type Browser = import("playwright").Browser;
type Page = import("playwright").Page;
type BrowserContext = import("playwright").BrowserContext;

let cachedPlaywright: PlaywrightModule | null = null;
let cachedBrowser: Browser | null = null;
let cachedContext: BrowserContext | null = null;

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  if (cachedPlaywright) return cachedPlaywright;
  try {
    cachedPlaywright = (await import("playwright")) as PlaywrightModule;
    return cachedPlaywright;
  } catch (err) {
    throw new Error(
      "Playwright is not installed. Run `npm install playwright && npx playwright install chromium` to enable the browser_* tools."
    );
  }
}

async function getOrCreateBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  if (cachedBrowser && cachedContext) {
    if (cachedBrowser.isConnected()) return { browser: cachedBrowser, context: cachedContext };
    cachedBrowser = null;
    cachedContext = null;
  }
  const playwright = await loadPlaywright();
  if (!playwright) throw new Error("Playwright unavailable");
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Rapa-Agent/1.0 (browser-automation)"
  });
  cachedBrowser = browser;
  cachedContext = context;
  return { browser, context };
}

/**
 * Track pages per agent run so the same run reuses its tab. We key by
 * `runId || conversationId` — when the run ends, callers can call
 * `closeAllPages()` to free memory.
 */
const pagesByRun = new Map<string, Page>();

function pageKey(context: ToolExecutionContext): string {
  return context.runId ?? context.conversationId;
}

async function getOrCreatePage(context: ToolExecutionContext): Promise<Page> {
  const key = pageKey(context);
  let page = pagesByRun.get(key);
  if (page && !page.isClosed()) return page;
  const { context: browserContext } = await getOrCreateBrowser();
  page = await browserContext.newPage();
  pagesByRun.set(key, page);
  return page;
}

export async function closeAllPages(): Promise<void> {
  for (const page of pagesByRun.values()) {
    try { await page.close(); } catch { /* ignore */ }
  }
  pagesByRun.clear();
  if (cachedContext) { try { await cachedContext.close(); } catch { /* ignore */ } cachedContext = null; }
  if (cachedBrowser) { try { await cachedBrowser.close(); } catch { /* ignore */ } cachedBrowser = null; }
}

// --- Shared utilities ------------------------------------------------------

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Tools ------------------------------------------------------------------

export class BrowserNavigateTool extends Tool {
  definition: ToolDefinition = {
    name: "browser_navigate",
    description: "Open a URL in a headless Chromium browser. The page is kept open between calls so subsequent browser_* tools (click, type, read, evaluate) act on the same page.",
    category: "browser",
    riskLevel: "network",
    requiresApproval: true,
    parameters: {
      url: {
        type: "string",
        description: "URL to navigate to (http or https)",
        required: true
      },
      waitUntil: {
        type: "string",
        description: "When to consider navigation complete. Defaults to \"load\".",
        required: false,
        enum: ["load", "domcontentloaded", "networkidle", "commit"]
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const url = typeof params.url === "string" ? params.url.trim() : "";
    if (!url) return { success: false, error: "url is required" };
    if (!/^https?:\/\//i.test(url)) return { success: false, error: "url must start with http:// or https://" };

    const waitUntil = (typeof params.waitUntil === "string" ? params.waitUntil : "load") as
      "load" | "domcontentloaded" | "networkidle" | "commit";

    try {
      const page = await getOrCreatePage(context);
      const response = await withTimeout(
        page.goto(url, { waitUntil, timeout: DEFAULT_NAV_TIMEOUT_MS }),
        DEFAULT_NAV_TIMEOUT_MS,
        "navigation"
      );
      return {
        success: true,
        data: {
          url: page.url(),
          finalUrl: page.url(),
          status: response?.status() ?? null,
          title: await page.title()
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Navigation failed" };
    }
  }
}

export class BrowserReadTool extends Tool {
  definition: ToolDefinition = {
    name: "browser_read",
    description: "Read content from the current browser page. Returns the page title, the full text (collapsed whitespace), or a screenshot saved to the workspace.",
    category: "browser",
    riskLevel: "read",
    parameters: {
      format: {
        type: "string",
        description: "What to return. Defaults to \"text\".",
        required: false,
        enum: ["text", "html", "title", "screenshot"]
      },
      selector: {
        type: "string",
        description: "Optional CSS selector. If provided, content is extracted from this element only.",
        required: false
      },
      maxChars: {
        type: "number",
        description: "Max characters to return (default 50000)",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const format = (typeof params.format === "string" ? params.format : "text") as "text" | "html" | "title" | "screenshot";
    const selector = typeof params.selector === "string" ? params.selector.trim() : undefined;
    const maxChars = typeof params.maxChars === "number" ? Math.min(Math.max(100, Math.floor(params.maxChars)), 500_000) : 50_000;

    try {
      const page = await getOrCreatePage(context);

      if (format === "screenshot") {
        // Save to workspace under .browser-screenshots/
        const dirRel = SCREENSHOTS_DIR;
        const dirFull = resolveWorkspacePath(dirRel, context.workspaceRoot);
        if (!isWithinWorkspace(dirFull, context.workspaceRoot)) {
          return { success: false, error: `screenshot dir ${dirRel} is outside the workspace` };
        }
        if (!existsSync(dirFull)) {
          await mkdir(dirFull, { recursive: true });
        }
        const filename = `screenshot-${Date.now()}-${randomBytes(3).toString("hex")}.png`;
        const fullPath = join(dirFull, filename);
        await page.screenshot({ path: fullPath, fullPage: false });
        return {
          success: true,
          data: {
            path: toWorkspaceRelativePath(fullPath, context.workspaceRoot),
            fullPath,
            url: page.url()
          }
        };
      }

      let content: string;
      if (format === "title") {
        content = await page.title();
      } else {
        const target = selector ? page.locator(selector).first() : page.locator("body");
        const exists = await target.count();
        if (selector && exists === 0) {
          return { success: false, error: `No element matched selector "${selector}"` };
        }
        content = format === "html" ? await target.innerHTML() : await target.innerText();
      }

      const truncated = content.length > maxChars;
      if (truncated) content = content.slice(0, maxChars);

      return {
        success: true,
        data: {
          format,
          url: page.url(),
          title: await page.title(),
          content,
          ...(truncated ? { truncated: true, totalChars: content.length + (truncated ? 1 : 0) } : {})
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Read failed" };
    }
  }
}

export class BrowserClickTool extends Tool {
  definition: ToolDefinition = {
    name: "browser_click",
    description: "Click an element on the current page. Use a CSS selector to target the element.",
    category: "browser",
    riskLevel: "write",
    requiresApproval: true,
    parameters: {
      selector: {
        type: "string",
        description: "CSS selector for the element to click",
        required: true
      },
      timeout: {
        type: "number",
        description: "How long to wait for the element to be clickable (ms). Default 10000.",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const selector = typeof params.selector === "string" ? params.selector.trim() : "";
    if (!selector) return { success: false, error: "selector is required" };
    const timeout = typeof params.timeout === "number" ? params.timeout : DEFAULT_ACTION_TIMEOUT_MS;

    try {
      const page = await getOrCreatePage(context);
      const element = page.locator(selector).first();
      const count = await element.count();
      if (count === 0) return { success: false, error: `No element matched selector "${selector}"` };
      await withTimeout(element.click({ timeout }), timeout, "click");
      return {
        success: true,
        data: {
          url: page.url(),
          clicked: selector
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Click failed" };
    }
  }
}

export class BrowserTypeTool extends Tool {
  definition: ToolDefinition = {
    name: "browser_type",
    description: "Type text into an input field on the current page. Use a CSS selector to target the field.",
    category: "browser",
    riskLevel: "write",
    requiresApproval: true,
    parameters: {
      selector: {
        type: "string",
        description: "CSS selector for the input/textarea element",
        required: true
      },
      text: {
        type: "string",
        description: "Text to type",
        required: true
      },
      submit: {
        type: "boolean",
        description: "Press Enter after typing (default false)",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const selector = typeof params.selector === "string" ? params.selector.trim() : "";
    const text = typeof params.text === "string" ? params.text : "";
    if (!selector) return { success: false, error: "selector is required" };
    if (text === "") return { success: false, error: "text is required" };

    try {
      const page = await getOrCreatePage(context);
      const element = page.locator(selector).first();
      const count = await element.count();
      if (count === 0) return { success: false, error: `No element matched selector "${selector}"` };
      await withTimeout(element.fill(text, { timeout: DEFAULT_ACTION_TIMEOUT_MS }), DEFAULT_ACTION_TIMEOUT_MS, "type");
      if (params.submit === true) {
        await withTimeout(element.press("Enter"), DEFAULT_ACTION_TIMEOUT_MS, "press Enter");
      }
      return {
        success: true,
        data: { url: page.url(), selector, submitted: params.submit === true }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Type failed" };
    }
  }
}

export class BrowserEvaluateTool extends Tool {
  definition: ToolDefinition = {
    name: "browser_evaluate",
    description: "Run arbitrary JavaScript in the current page and return the result. Use this to read computed styles, query DOM, or interact with frameworks.",
    category: "browser",
    riskLevel: "write",
    requiresApproval: true,
    parameters: {
      expression: {
        type: "string",
        description: "JavaScript expression to evaluate. Last value is returned.",
        required: true
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const expression = typeof params.expression === "string" ? params.expression : "";
    if (!expression.trim()) return { success: false, error: "expression is required" };
    if (expression.length > 10_000) return { success: false, error: "expression exceeds 10000 characters" };

    try {
      const page = await getOrCreatePage(context);
      const result = await withTimeout(
        page.evaluate(expression),
        DEFAULT_ACTION_TIMEOUT_MS,
        "evaluate"
      );
      return {
        success: true,
        data: {
          url: page.url(),
          result
        }
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Evaluate failed" };
    }
  }
}
