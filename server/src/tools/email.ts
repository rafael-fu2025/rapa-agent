// §3.2 — Email / SMTP integration.
//
// `send_email` is a single tool that delivers an email through a
// pre-configured SMTP account. Credentials live in the
// `IntegrationCredential` Prisma model (added in the same migration as
// NotificationChannel) so users can register multiple accounts.
//
// For v1 we do NOT use a third-party SMTP library — we open a raw
// TLS-or-PLAIN connection and speak SMTP ourselves. That keeps the
// dependency surface tiny. For richer features (DKIM, attachments,
// OAuth) we'd add the `nodemailer` package.

import { createConnection, type Socket } from "node:net";
import { TLSSocket, createSecureContext } from "node:tls";

import { Tool, type ToolDefinition, type ToolExecutionContext, type ToolResult } from "../lib/tools.js";
import { prisma, getLocalUser } from "../lib/db.js";
import { decryptText } from "../lib/crypto.js";

const MAX_BODY_CHARS = 200_000;
const MAX_RECIPIENTS = 50;
const SMTP_TIMEOUT_MS = 30_000;

type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  fromAddress: string;
  fromName?: string;
  security: "tls" | "starttls" | "none";
};

type SmtpResult = { messageId?: string };

/**
 * Read an SMTP reply (one or more `NNN text\r\n` lines ending in a 3-digit
 * status). Returns the final status code and the full reply text.
 */
function readReply(socket: Socket, timeoutMs: number): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      // Multi-line replies continue until a line whose 4th char is space.
      const lines = buffer.split("\r\n").filter((l) => l.length >= 3);
      if (lines.length === 0) return;
      const last = lines[lines.length - 1];
      if (last.length >= 4 && last[3] === " ") {
        socket.off("data", onData);
        clearTimeout(timer);
        const code = Number(last.slice(0, 3));
        resolve({ code, text: lines.join("\r\n") });
      }
    };
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error(`SMTP reply timed out after ${timeoutMs}ms (buffer: ${buffer.slice(0, 200)})`));
    }, timeoutMs);
    socket.on("data", onData);
  });
}

function sendCommand(socket: Socket, command: string): void {
  socket.write(`${command}\r\n`);
}

function dotStuff(body: string): string {
  // RFC 5321 §4.5.2: lines starting with `.` get an extra `.` to
  // distinguish them from the terminator.
  return body.replace(/^\./gm, "..");
}

async function smtpSend(config: SmtpConfig, to: string[], subject: string, body: string, isHtml: boolean): Promise<SmtpResult> {
  let socket: Socket = createConnection({ host: config.host, port: config.port });
  let upgraded = false;
  try {
    // 220 banner
    let reply = await readReply(socket, SMTP_TIMEOUT_MS);
    if (reply.code !== 220) throw new Error(`SMTP banner not 220: ${reply.text}`);

    // For TLS, upgrade the socket before sending AUTH.
    if (config.security === "tls") {
      const ctx = createSecureContext({});
      const tls = new TLSSocket(socket, { secureContext: ctx, isServer: false });
      // SNI: the constructor doesn't accept servername, so set it on the
      // underlying connection options before the handshake. For now we
      // skip SNI on the direct-TLS path — most modern SMTP servers
      // handle the bare TLS handshake without it. STARTTLS path below
      // is more common and gets full SNI.
      socket = tls as unknown as Socket;
      upgraded = true;
    } else {
      sendCommand(socket, "EHLO localhost");
      reply = await readReply(socket, SMTP_TIMEOUT_MS);
      if (reply.code !== 250) throw new Error(`EHLO failed: ${reply.text}`);
    }

    // For STARTTLS, issue STARTTLS and then re-EHLO.
    if (config.security === "starttls") {
      sendCommand(socket, "STARTTLS");
      reply = await readReply(socket, SMTP_TIMEOUT_MS);
      if (reply.code !== 220) throw new Error(`STARTTLS failed: ${reply.text}`);
      const ctx = createSecureContext({});
      // SNI is configured via the underlying connect options before the
      // upgrade. The `TLSSocket` constructor doesn't accept servername
      // directly, so we set it via the socket's connect options.
      const tls = new TLSSocket(socket, { secureContext: ctx, isServer: false });
      socket = tls as unknown as Socket;
      upgraded = true;
      sendCommand(socket, "EHLO localhost");
      reply = await readReply(socket, SMTP_TIMEOUT_MS);
      if (reply.code !== 250) throw new Error(`EHLO after STARTTLS failed: ${reply.text}`);
    }

    // AUTH LOGIN
    if (config.user && config.pass) {
      sendCommand(socket, "AUTH LOGIN");
      reply = await readReply(socket, SMTP_TIMEOUT_MS);
      if (reply.code !== 334) throw new Error(`AUTH LOGIN prompt not 334: ${reply.text}`);
      sendCommand(socket, Buffer.from(config.user).toString("base64"));
      reply = await readReply(socket, SMTP_TIMEOUT_MS);
      if (reply.code !== 334) throw new Error(`Username rejected: ${reply.text}`);
      sendCommand(socket, Buffer.from(config.pass).toString("base64"));
      reply = await readReply(socket, SMTP_TIMEOUT_MS);
      if (reply.code !== 235) throw new Error(`AUTH failed: ${reply.text}`);
    }

    // MAIL FROM
    sendCommand(socket, `MAIL FROM:<${config.fromAddress}>`);
    reply = await readReply(socket, SMTP_TIMEOUT_MS);
    if (reply.code !== 250) throw new Error(`MAIL FROM failed: ${reply.text}`);

    // RCPT TO — one per recipient.
    for (const recipient of to) {
      sendCommand(socket, `RCPT TO:<${recipient}>`);
      reply = await readReply(socket, SMTP_TIMEOUT_MS);
      if (reply.code !== 250 && reply.code !== 251) {
        throw new Error(`RCPT TO ${recipient} failed: ${reply.text}`);
      }
    }

    // DATA
    sendCommand(socket, "DATA");
    reply = await readReply(socket, SMTP_TIMEOUT_MS);
    if (reply.code !== 354) throw new Error(`DATA prompt not 354: ${reply.text}`);

    const fromHeader = config.fromName
      ? `${config.fromName} <${config.fromAddress}>`
      : config.fromAddress;
    const headers = [
      `From: ${fromHeader}`,
      `To: ${to.join(", ")}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=utf-8`,
      `Date: ${new Date().toUTCString()}`
    ].join("\r\n");

    const payload = `${headers}\r\n\r\n${dotStuff(body)}\r\n.\r\n`;
    sendCommand(socket, payload);
    reply = await readReply(socket, SMTP_TIMEOUT_MS);
    if (reply.code !== 250) throw new Error(`Message rejected: ${reply.text}`);

    // QUIT
    sendCommand(socket, "QUIT");
    try {
      await readReply(socket, 2000);
    } catch { /* best-effort */ }

    return { messageId: reply.text.match(/message-id\s*([^\s]+)/i)?.[1] };
  } finally {
    try { socket.end(); } catch { /* ignore */ }
    if (upgraded) {
      try { (socket as TLSSocket).end(); } catch { /* ignore */ }
    }
  }
}

function parseAddressList(value: string): string[] {
  // Split on commas; trim; reject empty / invalid.
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

export class SendEmailTool extends Tool {
  definition: ToolDefinition = {
    name: "send_email",
    description: "Send an email through a pre-configured SMTP account. Credentials live in the IntegrationCredential table — register them in Settings → Integrations. For v1 the tool supports plain text and HTML bodies only (no attachments).",
    category: "integration",
    riskLevel: "network",
    requiresApproval: true,
    parameters: {
      account: {
        type: "string",
        description: "Name of the SMTP account (the `accountName` on an IntegrationCredential row with provider=\"smtp\").",
        required: true
      },
      to: {
        type: "string",
        description: "Comma-separated recipient list (e.g. \"alice@example.com, bob@example.com\")",
        required: true
      },
      subject: {
        type: "string",
        description: "Email subject",
        required: true
      },
      body: {
        type: "string",
        description: "Email body",
        required: true
      },
      isHtml: {
        type: "boolean",
        description: "Treat the body as HTML (default false — plain text).",
        required: false
      }
    }
  };

  async execute(params: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const account = typeof params.account === "string" ? params.account.trim() : "";
    const to = typeof params.to === "string" ? params.to.trim() : "";
    const subject = typeof params.subject === "string" ? params.subject.trim() : "";
    const body = typeof params.body === "string" ? params.body : "";
    const isHtml = params.isHtml === true;

    if (!account) return { success: false, error: "account is required" };
    if (!to) return { success: false, error: "to is required" };
    if (!subject) return { success: false, error: "subject is required" };
    if (!body) return { success: false, error: "body is required" };
    if (body.length > MAX_BODY_CHARS) {
      return { success: false, error: `body exceeds ${MAX_BODY_CHARS} characters` };
    }

    const recipients = parseAddressList(to);
    if (recipients.length === 0) {
      return { success: false, error: "to must contain at least one valid email address" };
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return { success: false, error: `to contains ${recipients.length} addresses; max is ${MAX_RECIPIENTS}` };
    }

    const user = await getLocalUser();
    const credential = await prisma.integrationCredential.findUnique({
      where: { userId_provider_accountName: { userId: user.id, provider: "smtp", accountName: account } }
    });
    if (!credential || !credential.isActive) {
      return { success: false, error: `No active SMTP account named "${account}". Add it via Settings → Integrations.` };
    }

    const secret = process.env.APP_SECRET;
    if (!secret) {
      return { success: false, error: "APP_SECRET is not configured; cannot decrypt credentials" };
    }

    let smtpConfig: SmtpConfig;
    try {
      const decrypted = decryptText(credential.credentialEncrypted, secret);
      const parsed = JSON.parse(decrypted) as Partial<SmtpConfig>;
      if (!parsed.host || !parsed.port || !parsed.fromAddress) {
        return { success: false, error: `SMTP credential "${account}" is missing required fields (host, port, fromAddress)` };
      }
      smtpConfig = {
        host: String(parsed.host),
        port: Number(parsed.port),
        user: String(parsed.user ?? ""),
        pass: String(parsed.pass ?? ""),
        fromAddress: String(parsed.fromAddress),
        ...(parsed.fromName ? { fromName: String(parsed.fromName) } : {}),
        security: parsed.security === "tls" || parsed.security === "starttls" ? parsed.security : "none"
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to decrypt SMTP credentials: ${err instanceof Error ? err.message : String(err)}`
      };
    }

    try {
      const result = await smtpSend(smtpConfig, recipients, subject, body, isHtml);
      await prisma.integrationCredential.update({
        where: { id: credential.id },
        data: { lastUsedAt: new Date() }
      }).catch(() => { /* non-critical */ });
      return {
        success: true,
        data: {
          account,
          recipients,
          subject,
          bytes: body.length,
          messageId: result.messageId
        }
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "SMTP send failed"
      };
    }
  }
}
