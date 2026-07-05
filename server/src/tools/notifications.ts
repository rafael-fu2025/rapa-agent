// §3.3 — IM / webhook notifications.
//
// Sends a message to a configured webhook (Slack, Discord, Teams,
// Telegram, generic). Channel configurations are stored in the new
// `NotificationChannel` Prisma model — but for simplicity the tool
// also accepts an inline `webhookUrl` so the agent can fire a one-off
// notification without pre-configuration.

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { prisma, getLocalUser } from "../lib/db.js";
import { decryptText } from "../lib/crypto.js";

const MAX_BODY_CHARS = 4000;
const FETCH_TIMEOUT_MS = 15000;

type ChannelKind = "slack" | "discord" | "teams" | "telegram" | "generic";

function detectChannelKind(url: string): ChannelKind {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("slack.com")) return "slack";
    if (u.hostname.endsWith("discord.com") || u.hostname.endsWith("discordapp.com")) return "discord";
    if (u.hostname.includes("office.com") || u.hostname.includes("outlook.office.com")) return "teams";
    if (u.hostname.includes("telegram.org") || u.hostname.includes("t.me")) return "telegram";
    return "generic";
  } catch {
    return "generic";
  }
}

function buildPayload(kind: ChannelKind, message: string, format: "markdown" | "plain"): unknown {
  switch (kind) {
    case "slack":
      return { text: message };
    case "discord":
      return { content: message };
    case "teams":
      return { text: message };
    case "telegram":
      return { text: message, parse_mode: format === "markdown" ? "MarkdownV2" : undefined };
    case "generic":
    default:
      return { message, format };
  }
}

export class SendNotificationTool extends Tool {
  definition: ToolDefinition = {
    name: "send_notification",
    description: "Send a notification to a Slack / Discord / Teams / Telegram / generic webhook. Either reference a pre-configured channel by name, or pass `webhookUrl` directly for a one-off send.",
    category: "notification",
    riskLevel: "network",
    requiresApproval: true,
    parameters: {
      message: {
        type: "string",
        description: "Message body. Markdown is accepted when `format` is \"markdown\"; otherwise plain text.",
        required: true
      },
      channel: {
        type: "string",
        description: "Name of a pre-configured notification channel (from the NotificationChannel table). Either this or `webhookUrl` is required.",
        required: false
      },
      webhookUrl: {
        type: "string",
        description: "Direct webhook URL. Use this for one-off sends without pre-registering a channel. Either this or `channel` is required.",
        required: false
      },
      format: {
        type: "string",
        description: "How to format the message body. Defaults to \"plain\".",
        required: false,
        enum: ["plain", "markdown"]
      }
    }
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const message = typeof params.message === "string" ? params.message.trim() : "";
    if (!message) {
      return {
        success: false,
        error: "message is required and must be a non-empty string"
      };
    }
    if (message.length > MAX_BODY_CHARS) {
      return {
        success: false,
        error: `message exceeds ${MAX_BODY_CHARS} character limit (got ${message.length})`
      };
    }

    const format = (params.format as "markdown" | "plain" | undefined) ?? "plain";
    const channelName = typeof params.channel === "string" ? params.channel.trim() : undefined;
    const inlineUrl = typeof params.webhookUrl === "string" ? params.webhookUrl.trim() : undefined;

    if (!channelName && !inlineUrl) {
      return {
        success: false,
        error: "Either `channel` (a pre-configured channel name) or `webhookUrl` (a direct URL) is required"
      };
    }

    let webhookUrl = inlineUrl ?? "";
    let channelKind: ChannelKind = "generic";

    if (channelName && !inlineUrl) {
      const user = await getLocalUser();
      const channel = await prisma.notificationChannel.findUnique({
        where: { userId_name: { userId: user.id, name: channelName } }
      });
      if (!channel) {
        return {
          success: false,
          error: `No notification channel named "${channelName}". Add it via Settings → Notifications, or pass webhookUrl directly.`
        };
      }
      if (!channel.enabled) {
        return { success: false, error: `Channel "${channelName}" is disabled` };
      }
      const secret = process.env.APP_SECRET ?? "";
      if (!secret) {
        return { success: false, error: "APP_SECRET is not configured; cannot decrypt channel credentials" };
      }
      try {
        webhookUrl = decryptText(channel.webhookUrlEncrypted, secret);
      } catch (err) {
        return {
          success: false,
          error: `Failed to decrypt webhook URL for channel "${channelName}": ${err instanceof Error ? err.message : String(err)}`
        };
      }
      channelKind = (channel.kind as ChannelKind) ?? detectChannelKind(webhookUrl);

      // Increment useCount for visibility in the channel list.
      await prisma.notificationChannel.update({
        where: { id: channel.id },
        data: {
          useCount: { increment: 1 },
          lastUsedAt: new Date()
        }
      }).catch(() => { /* fire-and-forget; non-critical */ });
    } else {
      channelKind = detectChannelKind(webhookUrl);
    }

    const payload = buildPayload(channelKind, message, format);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(msg)) {
        return {
          success: false,
          error: `Webhook timed out after ${FETCH_TIMEOUT_MS}ms. Check the URL or service availability.`
        };
      }
      return { success: false, error: `Webhook request failed: ${msg}` };
    }
    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      return {
        success: false,
        error: `Webhook responded ${response.status} ${response.statusText}: ${errText.slice(0, 500)}`
      };
    }

    return {
      success: true,
      data: {
        channel: channelName ?? "(inline)",
        kind: channelKind,
        status: response.status,
        statusText: response.statusText,
        bytes: message.length
      }
    };
  }
}

export class ListNotificationChannelsTool extends Tool {
  definition: ToolDefinition = {
    name: "list_notification_channels",
    description: "List the user's configured notification channels (Slack / Discord / Teams / Telegram / generic). Webhook URLs are NOT included in the response — only metadata (name, kind, enabled, use count).",
    category: "notification",
    riskLevel: "read",
    parameters: {}
  };

  async execute(_params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const user = await getLocalUser();
    const rows = await prisma.notificationChannel.findMany({
      where: { userId: user.id },
      orderBy: { name: "asc" }
    });
    return {
      success: true,
      data: {
        channels: rows.map((r) => ({
          name: r.name,
          kind: r.kind,
          enabled: r.enabled,
          useCount: r.useCount,
          lastUsedAt: r.lastUsedAt?.toISOString() ?? null
        }))
      }
    };
  }
}
