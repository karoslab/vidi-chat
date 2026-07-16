import fs from "node:fs";
import path from "node:path";
import { dataPath, secureDataFile } from "./data-dir.ts";

/**
 * Stage 5 — the Discord notification MIRROR.
 *
 * Discord is a one-way NOTIFICATION mirror, not a control surface: the customer
 * pastes ONE webhook URL for their own free Discord server and the app POSTs
 * short pings to it. There is no bot and no approve-from-Discord — the in-app
 * approval desk stays the source of truth. Fire points (all best-effort, quiet
 * by default otherwise): new work opened by Vidi, work approved, work failed.
 *
 * EGRESS NOTE: this is a CUSTOMER-CONFIGURED, customer-consented egress channel.
 * lib/ping-discord.ts (the owner-only ops telemetry) no-ops for a non-owner
 * install because that ping targets the owner's ops server. This is different:
 * the customer pasted THEIR OWN webhook and passed the mandatory test ping, so
 * sending to it is exactly what they asked for. The gate here is therefore
 * "is a webhook configured", which IS the explicit opt-in — not isOwner().
 *
 * The stored URL is a capability (anyone holding it can post to the channel),
 * so data/discord-webhook.json is gitignored (all of data/ is), chmod 0600, and
 * on the SECRET_PATHS denylist in lib/providers/claude.ts so the agent's
 * Read/Edit/Write tools can neither exfiltrate it nor redirect it.
 */

const webhookFile = () => dataPath("discord-webhook.json");

interface WebhookRecord {
  url: string;
  lastTestPingAt: number | null;
  lastTestPingOk: boolean;
}

export interface WebhookConfig {
  /** null when nothing is stored. */
  url: string | null;
  configured: boolean;
  lastTestPingAt: number | null;
  lastTestPingOk: boolean;
}

/** Discord webhook hosts we accept (all the official variants). */
const WEBHOOK_HOSTS = new Set([
  "discord.com",
  "canary.discord.com",
  "ptb.discord.com",
  "discordapp.com",
]);

export class WebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookValidationError";
  }
}

/**
 * Validate a pasted webhook URL. Returns null when valid, else a plain-language
 * reason safe to show verbatim. Must be an https discord.com/api/webhooks link.
 */
export function validateWebhookUrl(raw: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) {
    return "Paste the webhook link first.";
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "That doesn't look like a link. Paste the whole web address that starts with https://discord.com/api/webhooks/.";
  }
  if (parsed.protocol !== "https:") {
    return "The link should start with https://. Copy it again from Discord.";
  }
  const pathOk = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+/.test(parsed.pathname);
  if (!WEBHOOK_HOSTS.has(parsed.hostname) || !pathOk) {
    return "That link isn't a Discord webhook address. It should start with https://discord.com/api/webhooks/. In Discord open your channel's settings, then Integrations, then Webhooks, and copy the webhook URL.";
  }
  return null;
}

function readRecord(): WebhookRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(webhookFile(), "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.url === "string") {
      return {
        url: parsed.url,
        lastTestPingAt: typeof parsed.lastTestPingAt === "number" ? parsed.lastTestPingAt : null,
        lastTestPingOk: parsed.lastTestPingOk === true,
      };
    }
  } catch {
    /* no file / corrupt — treated as unconfigured */
  }
  return null;
}

function writeRecord(record: WebhookRecord): void {
  fs.mkdirSync(path.dirname(webhookFile()), { recursive: true });
  const tmp = `${webhookFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, webhookFile());
  secureDataFile(webhookFile()); // 0600 — the URL is a capability
}

/** Current config (never leaks the raw URL to a read caller beyond `configured`
 *  — the route decides how much to echo). */
export function getWebhookConfig(): WebhookConfig {
  const record = readRecord();
  return {
    url: record?.url ?? null,
    configured: !!record,
    lastTestPingAt: record?.lastTestPingAt ?? null,
    lastTestPingOk: record?.lastTestPingOk ?? false,
  };
}

/** Store a webhook URL (validates first; throws WebhookValidationError on a bad
 *  value). Storing a NEW url resets the test-ping gate — a fresh URL must be
 *  re-tested before verify() passes. */
export function setWebhookUrl(raw: string): void {
  const reason = validateWebhookUrl(raw);
  if (reason) throw new WebhookValidationError(reason);
  writeRecord({ url: raw.trim(), lastTestPingAt: null, lastTestPingOk: false });
}

/** Remove the stored webhook (customer skips / disconnects). */
export function clearWebhook(): void {
  try {
    fs.rmSync(webhookFile());
  } catch {
    /* nothing stored */
  }
}

/** The webhook is READY (verify() passes) only when a URL is stored AND its
 *  last test ping returned 2xx. */
export function webhookReady(): boolean {
  const record = readRecord();
  return !!record && record.lastTestPingOk;
}

export interface PingResult {
  ok: boolean;
  status?: number;
  /** True when there was nothing to send to (no webhook configured). */
  skipped?: boolean;
  error?: string;
}

/** Injectable POST so tests never hit the network. Default uses global fetch. */
export type Poster = (url: string, body: unknown) => Promise<{ ok: boolean; status: number }>;

const defaultPoster: Poster = async (url, body) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Send one ping to the customer's stored webhook. No-op ({skipped:true}) when
 * nothing is configured — quiet by default. Never throws; a network error is
 * returned as {ok:false}. This is the mirror used by the fire points.
 */
export async function sendPing(
  text: string,
  deps: { post?: Poster } = {}
): Promise<PingResult> {
  const record = readRecord();
  if (!record) return { ok: false, skipped: true };
  const post = deps.post ?? defaultPoster;
  try {
    const { ok, status } = await post(record.url, { content: text });
    return { ok, status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The MANDATORY test ping run on save (item 5): send a friendly hello and record
 * whether it returned 2xx. verify() (webhookReady) then passes only if this
 * succeeded. Returns the result so the setup UI can show success/failure.
 */
export async function sendTestPing(deps: { post?: Poster } = {}): Promise<PingResult> {
  const record = readRecord();
  if (!record) return { ok: false, skipped: true };
  const result = await sendPing(
    "Vidi is connected. This channel will show you when there's work waiting for your OK.",
    deps
  );
  writeRecord({
    url: record.url,
    lastTestPingAt: Date.now(),
    lastTestPingOk: result.ok,
  });
  return result;
}
