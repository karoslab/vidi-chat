import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";
import { randomBytes } from "node:crypto";
import { appendJournal } from "./journal.ts";
import { workspacePath } from "./workspace.ts";
import { isOwner } from "./user-config.ts";

/**
 * The single phone-push chokepoint. Every part of the proactivity spine that
 * needs to reach the owner's phone (broker `push` deliveries, critical alerts)
 * calls pushToPhone — nothing else spawns notify.py or talks to a push
 * transport directly. Concentrating it here means the day-0 Discord transport
 * can be swapped for ntfy/APNs later without touching a single caller.
 *
 * Transport is a CHAIN, not a single call: an ordered list of async senders is
 * tried in turn, first success wins. New transports (ntfy topic, APNs token)
 * are added by prepending to `transports` (or via registerTransport) so they
 * take priority while Discord remains the always-available fallback. Today the
 * chain is [ntfy, discord]: ntfy.sh gives a real deliver ack + phone-native
 * priority, Discord stays behind it as the always-on fallback.
 *
 * Fail-open is the whole point of this module: a push must NEVER throw into a
 * voice turn or a broker tick. Every transport is wrapped, every failure is
 * swallowed, and the worst case is a `false` return — never an exception.
 */

/** Discord channel that acts as the owner's phone (mobile Discord push). "pm"
 *  is the personal/project-management channel, kept separate from ops noise. */
const PUSH_DISCORD_CHANNEL = "pm";

/** The optional Discord fallback: an external `ops/notify.py` sibling script
 *  (not shipped here), invoked as `python3 notify.py --channel <name> --text
 *  <msg>`; it reads its own bot token + channel map from the ops .env chain.
 *  Entirely optional — ntfy is the standalone default transport and works
 *  without it. Point at your own equivalent via setNotifyScriptPath() /
 *  registerTransport(). */
const DEFAULT_NOTIFY_SCRIPT = workspacePath("ops", "notify.py");

/**
 * Overridable only so tests can point the Discord transport at a bogus path
 * and assert we degrade to `false` instead of throwing. Not part of the
 * production contract — real callers never set this.
 */
let notifyScriptPath = DEFAULT_NOTIFY_SCRIPT;

export function setNotifyScriptPath(p: string): void {
  notifyScriptPath = p;
}

export type PushPriority = "low" | "default" | "high" | "urgent";

/**
 * A transport attempts one delivery and resolves true on success, false if it
 * couldn't deliver (or isn't configured). It must never reject — the chain
 * relies on that, but pushToPhone double-guards anyway.
 */
type PushTransport = (
  title: string,
  body: string,
  priority: PushPriority
) => Promise<boolean>;

// ── ntfy transport ──────────────────────────────────────────────────────────

/**
 * ntfy.sh base. A push POSTs to `${NTFY_BASE}/<topic>`; whoever is subscribed
 * to that topic on their phone gets a native push. The topic name IS the
 * secret (anyone who knows it can publish/subscribe), so data/ntfy-topic is a
 * secret file — gitignored via data/, chmod 0600, and on the SECRET_PATHS
 * no-read list. Never log or commit it.
 */
const NTFY_BASE = "https://ntfy.sh";

/** A push must never hang a voice turn: bound the network wait, then fall
 *  through to Discord. */
const NTFY_TIMEOUT_MS = 5000;

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/ntfy-topic.
const defaultNtfyTopicFile = () => dataPath("ntfy-topic");

/**
 * Overridable only so tests can point the topic at a throwaway temp file and
 * assert autogeneration without touching the real secret. Real callers never
 * set this.
 */
let ntfyTopicPath = defaultNtfyTopicFile();

export function setNtfyTopicPath(p: string): void {
  ntfyTopicPath = p;
}

/**
 * Read the ntfy topic, minting one on first use. The topic is a 32-hex-char
 * random string (16 bytes) written 0600 — it's a bearer secret, so it must be
 * unguessable and unreadable to other users. Returns null if it can't be read
 * or created (transport then reports false and the chain falls through).
 */
function loadNtfyTopic(): string | null {
  try {
    const existing = fs.readFileSync(ntfyTopicPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* not minted yet — fall through to create it */
  }
  try {
    const topic = randomBytes(16).toString("hex");
    fs.mkdirSync(path.dirname(ntfyTopicPath), { recursive: true });
    fs.writeFileSync(ntfyTopicPath, topic + "\n", { mode: 0o600 });
    // writeFileSync only honours `mode` when it creates the file; force 0600 in
    // case an earlier run left a laxer file behind.
    fs.chmodSync(ntfyTopicPath, 0o600);
    return topic;
  } catch {
    return null;
  }
}

/** Map our priority onto ntfy's Priority header. "urgent" (our critical level)
 *  → ntfy "urgent", "high" → "high", everything else → "default". */
function ntfyPriorityHeader(priority: PushPriority): string {
  if (priority === "urgent") return "urgent";
  if (priority === "high") return "high";
  return "default";
}

/** A tag renders as an emoji on the phone; escalate with priority. */
function ntfyTags(priority: PushPriority): string {
  if (priority === "urgent") return "rotating_light";
  if (priority === "high") return "warning";
  return "bell";
}

/**
 * Head-of-chain transport: a real push via ntfy.sh. Unlike Discord this gives a
 * genuine HTTP deliver ack (2xx) and native phone priority. A non-2xx response
 * or any network/timeout error resolves false so the chain falls through to
 * Discord — the push still gets there.
 */
const ntfyTransport: PushTransport = async (title, body, priority) => {
  const topic = loadNtfyTopic();
  if (!topic) return false;
  try {
    const res = await fetch(`${NTFY_BASE}/${topic}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: ntfyPriorityHeader(priority),
        Tags: ntfyTags(priority),
      },
      body,
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    // Network error, DNS failure, or timeout — degrade to the next transport.
    return false;
  }
};

// ── Discord transport ────────────────────────────────────────────────────────

/**
 * Day-0 fallback transport: fire-and-forget Discord via notify.py, mirroring
 * the voice route's pingDiscord (detached + unref + swallow so it can't block
 * or crash the caller). notify.py is spawned, not awaited for delivery
 * confirmation, so "success" here means "we launched the sender without a spawn
 * error" — a genuine deliver/fail ack is a property of a real push API (ntfy),
 * which is exactly why ntfy sits ahead of it in the chain. We can't map
 * priority onto notify.py (it takes none), so priority is accepted and ignored
 * at this hop.
 */
const discordTransport: PushTransport = (title, body, _priority) =>
  new Promise<boolean>((resolve) => {
    const text = `${title} — ${body}`;
    try {
      const child = spawn(
        "python3",
        [notifyScriptPath, "--channel", PUSH_DISCORD_CHANNEL, "--text", text],
        { stdio: "ignore", detached: true }
      );
      // A spawn that never starts (bad interpreter, missing script dir) surfaces
      // as an async 'error' event, not a throw — that's a failed transport.
      child.on("error", () => resolve(false));
      // Otherwise we've handed off; treat the launch as delivered and let the
      // child outlive us.
      child.unref();
      resolve(true);
    } catch {
      // Synchronous spawn failure (e.g. invalid argument types) — degrade.
      resolve(false);
    }
  });

// ── Chain ─────────────────────────────────────────────────────────────────────

interface Transport {
  name: string;
  send: PushTransport;
}

/**
 * Ordered transport chain. ntfy is at the HEAD (real deliver ack + priority),
 * Discord stays last as the always-on fallback. Prepend higher-priority
 * transports (APNs) as they land.
 */
const transports: Transport[] = [
  { name: "ntfy", send: ntfyTransport },
  { name: "discord", send: discordTransport },
];

/**
 * Register a new transport at the front of the chain (tried before existing
 * ones). This is the seam future push backends plug into without editing
 * pushToPhone or any caller.
 */
export function registerTransport(
  transport: PushTransport,
  name = "custom"
): void {
  transports.unshift({ name, send: transport });
}

/** Per-transport delivery outcome, for the journal and test introspection. */
export interface DeliveryRecord {
  ts: number;
  transport: string;
  ok: boolean;
  priority: PushPriority;
}

/** Small in-memory ring of recent per-transport outcomes, mirroring what gets
 *  journaled. Lets callers/tests inspect what the chain actually did. */
const deliveries: DeliveryRecord[] = [];

/** Recent per-transport delivery outcomes, oldest first. */
export function recentDeliveries(): DeliveryRecord[] {
  return deliveries.slice();
}

/** Clear the in-memory delivery ring (test isolation). */
export function resetDeliveries(): void {
  deliveries.length = 0;
}

/** Record one transport's outcome to the in-memory ring and the action journal.
 *  The title/body are NOT journaled — a push can carry private content, and the
 *  ntfy topic must never leak; only transport + outcome + priority. */
function recordDelivery(
  transport: string,
  ok: boolean,
  priority: PushPriority
): void {
  const rec: DeliveryRecord = { ts: Date.now(), transport, ok, priority };
  deliveries.push(rec);
  if (deliveries.length > 50) deliveries.shift();
  appendJournal({
    ts: rec.ts,
    threadId: "push",
    tool: `push:${transport}`,
    summary: `${ok ? "delivered" : "failed"} (${priority})`,
  });
}

/**
 * Push a short notification to the owner's phone. Tries each transport in order
 * and returns true on the first success. Returns false if every transport
 * failed or none is configured. Never throws.
 *
 * `urgent` is the critical level: it always fans out to EVERY transport (both
 * ntfy and Discord), so a critical alert can't be silently dropped by one
 * backend. Lower priorities stop at the first success.
 */
export async function pushToPhone(
  title: string,
  body: string,
  priority: PushPriority = "default"
): Promise<boolean> {
  // Phase 4a — H8: a NON-owner install makes ZERO external network
  // calls. Both transports here are external (ntfy.sh + Discord via notify.py),
  // so short-circuit to a local-only no-op before any transport runs. Returns
  // false (nothing delivered) exactly like an all-transports-failed result, so
  // every fail-open caller (broker tick, alerts) behaves unchanged. Owner
  // installs are untouched.
  if (!isOwner()) {
    recordDelivery("local-only", false, priority);
    return false;
  }
  const critical = priority === "urgent";
  let delivered = false;
  for (const { name, send } of transports) {
    let ok = false;
    try {
      ok = await send(title, body, priority);
    } catch {
      // A misbehaving transport that rejects/throws must not sink the chain —
      // treat it as a failed hop and move on to the next one.
      ok = false;
    }
    recordDelivery(name, ok, priority);
    delivered = delivered || ok;
    // First success wins — except for a critical push, which keeps going so it
    // reaches every backend.
    if (ok && !critical) return true;
  }
  return delivered;
}
