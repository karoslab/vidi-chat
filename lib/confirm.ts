import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataPath } from "./data-dir.ts";
import { redactSecretsDeep } from "./redact.ts";
import { appendJournal } from "./journal.ts";

/**
 * The confirm-tier core: a single-slot pending-action queue with a durable
 * executor registry.
 *
 * Risky actions — anything that changes the world irreversibly (send an email,
 * create a calendar event, write a file outside the safe dirs, drive the Hands
 * server) — are parked here as ONE pending action, and Vidi asks out loud
 * "should I go ahead?". The user answers on the next turn ("confirm" / "cancel
 * that", intercepted in lib/voice-turn.ts), and only then does the action run.
 *
 * ## Two ways to file an action, one way to run it
 *
 * 1. **Registry-based (`fileConfirm`)** — the action persists as a plain
 *    `{kind, payload}` record on disk. Execution is RECONSTRUCTED at confirm
 *    time from a server-registered executor for that `kind`. Because nothing
 *    about running the action lives in RAM, a pending action SURVIVES a process
 *    restart: the JSON is enough to run it. This is what `bin/vidi-act` +
 *    `POST /api/confirm/request` use, and it is the path the owner's voice
 *    "confirm" fires after the app has been restarted.
 *
 * 2. **Closure-based (`requestConfirm`)** — the legacy/in-process API: the
 *    caller hands an `execute` closure that lives ONLY in a module-level Map.
 *    A restart drops the closure, so the slot fails safe (nothing to run). Kept
 *    for any in-process caller that wants an ad-hoc action; the registry path
 *    is preferred for everything durable.
 *
 * Both share the same single slot, the same 120s TTL, the same depth-1
 * semantics, and the same `confirmPending`/`cancelPending`/`hasPending`
 * readers — so the voice intercepts don't care which path filed the action.
 *
 * Design decisions and WHY:
 *  - Depth 1. A voice UI can only hold one "waiting on you" in a human's head
 *    at a time. A second file REPLACES the first — the newest ask is the one
 *    the user actually just heard.
 *  - TTL 120s. "Yes" three minutes later almost certainly means yes to
 *    something else. An expired slot is treated as empty everywhere.
 *  - Registry executors are pure functions of `payload` registered ONCE at
 *    module load (see the bottom of this file). They are looked up by `kind`
 *    at confirm time, so no closure ever needs to be serialized or survive in
 *    RAM. This is the fix for the old RAM-map fragility.
 *  - The JSON record carries `{pendingId, kind, description, ts, ttlMs}` and,
 *    for registry actions, `payload`. A closure action stores no payload (its
 *    execute fn is the RAM Map) — so on restart it is correctly dead.
 *  - Everything is fail-open and never throws into a voice turn. The worst case
 *    is "nothing is pending", the safe direction for a risky action.
 */

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) so a fresh-install rehearsal points at the temp dir. Unset →
// path.join(process.cwd(), "data", "pending-action.json"), byte-identical.
const pendingFile = () => dataPath("pending-action.json");

/** Default time-to-live for a pending action, in milliseconds. */
const DEFAULT_TTL_MS = 120_000;

/** The on-disk record. `payload` present ⇒ registry action; absent ⇒ closure. */
interface PendingRecord {
  pendingId: string;
  kind: string;
  description: string;
  /** Epoch ms the action was requested; TTL is measured from here. */
  ts: number;
  /** TTL for this specific slot, so an override travels with the record. */
  ttlMs: number;
  /**
   * For registry actions: the data an executor reconstructs the action from.
   * Absent for legacy closure actions (their fn lives in `closureExecutors`).
   */
  payload?: unknown;
  /**
   * B1 (Layer A) — a per-command random nonce minted when the action is filed.
   * Approving the action requires presenting THIS exact nonce (the owner's Swift
   * overlay carries it, machine-side, when it forwards the approval). It kills
   * the "confirm is a fixed guessable string" forge: a blind local POST can no
   * longer approve a parked action without the fresh secret bound to it. Absent
   * only on legacy records hand-written before this field existed (those keep
   * running so a durable pre-restart record isn't stranded — see confirmPending).
   */
  nonce?: string;
}

/** Mint a fresh per-command approval nonce (Layer A). Random, never user-facing
 *  (O1: machine-carried), so it can't be guessed or overheard. */
function mintNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}

/** Constant-time nonce compare on the raw strings; unequal lengths short-circuit
 *  to false (timingSafeEqual throws on length mismatch). */
function nonceMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * A server-registered executor: a pure async function of a payload that
 * performs the side effect and returns spoken text. Registered once per `kind`
 * at module load, so a `{kind, payload}` record read off disk after a restart
 * is fully runnable with no RAM state.
 */
type Executor = (payload: unknown) => Promise<string>;

/** kind → executor. Populated by `registerExecutor` at module load (bottom). */
const registry = new Map<string, Executor>();

/**
 * Legacy in-process closures, keyed by pendingId, kept in RAM only. A record on
 * disk with a matching entry here runs via the closure; a registry record
 * (payload present) never touches this map.
 */
const closureExecutors = new Map<string, () => Promise<string>>();

/**
 * Register a server-side executor for a `kind`. Called once per kind at module
 * load. Idempotent-ish: a later registration overrides an earlier one (the
 * last definition wins), which keeps hot-reload sane in dev.
 */
export function registerExecutor(kind: string, fn: Executor): void {
  registry.set(kind, fn);
}

/** Read the persisted record, fail-open to null on any missing/corrupt file. */
function readRecord(): PendingRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingFile(), "utf8")) as PendingRecord;
    if (typeof raw.pendingId !== "string" || typeof raw.ts !== "number") {
      return null;
    }
    return raw;
  } catch {
    // Missing (nothing pending) or corrupt — either way, nothing to run.
    return null;
  }
}

/** Persist the record. Never throws — a failed write must not break a turn. */
function writeRecord(rec: PendingRecord): void {
  try {
    fs.mkdirSync(path.dirname(pendingFile()), { recursive: true });
    // tmp-then-rename so a concurrent reader never sees a torn file (same
    // discipline as lib/store.ts and lib/event-spool.ts).
    const tmp = `${pendingFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, pendingFile());
  } catch {
    /* fail-open: an un-persisted slot just won't survive a reload */
  }
}

/** Remove the persisted record. Never throws; a missing file is success. */
function deleteRecord(): void {
  try {
    fs.rmSync(pendingFile(), { force: true });
  } catch {
    /* fail-open */
  }
}

/** Is this record still within its TTL, measured against `now`? */
function isFresh(rec: PendingRecord, now: number): boolean {
  return now <= rec.ts + rec.ttlMs;
}

/**
 * Can this record actually be run right now? A registry action (payload
 * present) is runnable iff an executor is registered for its kind — which, by
 * construction, it always is after module load, so registry actions survive
 * restarts. A closure action is runnable iff its fn is still in the RAM map —
 * which a restart clears, so it correctly dies.
 */
function isRunnable(rec: PendingRecord): boolean {
  if (Object.prototype.hasOwnProperty.call(rec, "payload")) {
    // Registry actions are durable on disk. Executors load asynchronously
    // (ensureExecutors) after this module initializes. Requiring registry.has
    // while still loading races module-init and flaked CI (pendingView/
    // hasPending returned null immediately after fileConfirm). Once the
    // registry is loaded, unknown kinds fail safe (not runnable).
    // confirmPending awaits ensureExecutors() before execute.
    if (!executorsLoaded) return true;
    return registry.has(rec.kind);
  }
  return closureExecutors.has(rec.pendingId);
}

/**
 * Return the current pending record only if it is BOTH fresh AND runnable.
 * Anything else — no file, expired, or a closure record orphaned by a restart —
 * resolves to null, and we clear the dead slot so the queue self-heals.
 */
function liveRecord(now: number): PendingRecord | null {
  const rec = readRecord();
  if (!rec) return null;
  if (!isFresh(rec, now) || !isRunnable(rec)) {
    // Dead slot — drop the file and any stale closure so nothing lingers.
    closureExecutors.delete(rec.pendingId);
    deleteRecord();
    return null;
  }
  return rec;
}

/**
 * File a registry-backed pending action. The action persists as
 * `{kind, payload, description}`; at confirm time the executor registered for
 * `kind` runs it from `payload`. Survives restarts (no RAM state).
 *
 * @returns {pendingId, description} so the caller can echo the ask to the user.
 */
export function fileConfirm(
  action: { kind: string; payload: unknown; description: string },
  opts: { now?: number; ttlMs?: number } = {}
): { pendingId: string; description: string; nonce: string } {
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const ttlMs = typeof opts.ttlMs === "number" ? opts.ttlMs : DEFAULT_TTL_MS;

  // Depth 1: whatever was waiting is superseded. Clear its closure (if any) so
  // a replaced action can never run.
  const prior = readRecord();
  if (prior) closureExecutors.delete(prior.pendingId);

  const pendingId = `pending-${now}-${crypto.randomBytes(4).toString("hex")}`;
  const nonce = mintNonce();
  const rec: PendingRecord = {
    pendingId,
    kind: action.kind,
    description: action.description,
    ts: now,
    ttlMs,
    payload: action.payload ?? null,
    nonce,
  };
  writeRecord(rec);

  return { pendingId, description: action.description, nonce };
}

/**
 * Park a risky action as THE pending action via an in-process closure (legacy /
 * ad-hoc path). The execute fn is stored in RAM only; a restart drops it, so
 * the slot fails safe. Prefer `fileConfirm` for anything that must survive a
 * restart (which is everything the owner confirms by voice after the app cycles).
 *
 * @returns {pendingId, description} so the caller can echo the ask to the user.
 */
export function requestConfirm(
  action: {
    kind: string;
    description: string;
    execute: () => Promise<string>;
  },
  opts: { now?: number; ttlMs?: number } = {}
): { pendingId: string; description: string; nonce: string } {
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const ttlMs = typeof opts.ttlMs === "number" ? opts.ttlMs : DEFAULT_TTL_MS;

  // Depth 1: whatever was waiting is superseded. Clear its closure so a
  // replaced action can never run — the user only heard the newest ask.
  const prior = readRecord();
  if (prior) closureExecutors.delete(prior.pendingId);

  const pendingId = `pending-${now}-${crypto.randomBytes(4).toString("hex")}`;
  const nonce = mintNonce();
  closureExecutors.set(pendingId, action.execute);

  // No `payload` key ⇒ this is a closure record (dead after a restart).
  const rec: PendingRecord = {
    pendingId,
    kind: action.kind,
    description: action.description,
    ts: now,
    ttlMs,
    nonce,
  };
  writeRecord(rec);

  return { pendingId, description: action.description, nonce };
}

/** True iff there is a fresh, runnable pending action right now. */
export function hasPending(now: number = Date.now()): boolean {
  return liveRecord(now) !== null;
}

/** The pending action's description, or null when nothing live is waiting. */
export function pendingDescription(now: number = Date.now()): string | null {
  const rec = liveRecord(now);
  return rec ? rec.description : null;
}

/**
 * The live pending action's approval fields — description plus the per-command
 * nonce the trusted UI must carry back to approve it (B1 Layer A). Null when
 * nothing live is waiting, or when the live record has no nonce (only legacy
 * hand-written records lack one; those are approved without a nonce, so there is
 * nothing to hand out). Returns the raw nonce, so a CALLER that exposes this
 * over HTTP MUST gate it on a valid control token (verifyControlToken) — the
 * nonce is machine-side only (O1) and never goes to a tokenless/blind caller.
 */
export function pendingApproval(
  now: number = Date.now()
): { pendingId: string; description: string; nonce: string } | null {
  const rec = liveRecord(now);
  if (!rec || !rec.nonce) return null;
  return { pendingId: rec.pendingId, description: rec.description, nonce: rec.nonce };
}

/**
 * The live pending action as the browser confirm card renders it: the REDACTED
 * description (never the raw payload), the action `kind` (mapped to a plain
 * app/data label client-side), the absolute `expiresAt` epoch ms (ts + ttlMs)
 * so the card can run its own countdown, and the per-command `nonce` the Approve
 * click carries back. Null when nothing live is waiting.
 *
 * The nonce is returned here the same way pendingApproval returns it — this is
 * the browser-path read of that same secret. A CALLER exposing this over HTTP
 * (GET /api/confirm/pending) MUST gate it on a positive session/control token
 * (requireReadAuth): a prompt-injected act-mode agent cannot read the session or
 * control token (both are in SECRET_PATHS, denied to act-mode Read/Edit/Write
 * and the Bash deny-secret-read hook), so exposing the nonce to a same-origin
 * session-authenticated browser caller does not lower the gate below what that
 * token already provides, while preserving the nonce's remaining value: it binds
 * the Approve click to the exact action the user saw, so a depth-1 plan mutation
 * between poll and click fails closed in confirmPending's nonce match.
 */
export function pendingView(
  now: number = Date.now()
): { description: string; nonce: string; kind: string; expiresAt: number } | null {
  const rec = liveRecord(now);
  if (!rec || !rec.nonce) return null;
  return {
    description: rec.description,
    nonce: rec.nonce,
    kind: rec.kind,
    expiresAt: rec.ts + rec.ttlMs,
  };
}

/**
 * Run the pending action if one is live, then clear the slot so it can only
 * fire once. A registry action runs via its `kind` executor over `payload`; a
 * closure action runs its RAM fn. A second confirm is a no-op (slot gone). If
 * the action throws, we still clear the slot and return a spoken failure.
 *
 * @returns {ran, text} — text is always safe to speak aloud.
 */
export async function confirmPending(
  now: number = Date.now(),
  opts: { nonce?: string | null } = {}
): Promise<{ ran: boolean; text: string }> {
  // Make sure the registry is populated before we judge runnability — on a
  // cold restart the warm-up may still be in flight.
  await ensureExecutors();
  const rec = liveRecord(now);
  if (!rec) {
    return { ran: false, text: "Nothing is waiting on you." };
  }

  // B1 (Layer A) — the approval must present THIS action's per-command nonce.
  // A record filed by fileConfirm/requestConfirm always carries one; a missing
  // or mismatched nonce is a forged/blind approval and is rejected WITHOUT
  // clearing the slot (an attacker's wrong guess must not burn a pending action
  // the real UI could still approve). Returns the same "nothing waiting" line as
  // an empty slot so it leaks no oracle about what's parked. Records with NO
  // nonce (only legacy/hand-written ones — every real filing sets it) skip this
  // check so a durable pre-restart record isn't stranded.
  if (rec.nonce) {
    const provided = typeof opts.nonce === "string" ? opts.nonce : "";
    if (!nonceMatches(provided, rec.nonce)) {
      return { ran: false, text: "Nothing is waiting on you." };
    }
  }

  const isRegistry = Object.prototype.hasOwnProperty.call(rec, "payload");
  const closure = closureExecutors.get(rec.pendingId);
  const executor = registry.get(rec.kind);

  // Clear BEFORE running so any error or re-entrancy can't fire twice — the
  // slot is single-shot the moment we commit to confirming it.
  closureExecutors.delete(rec.pendingId);
  deleteRecord();

  // P8 finding 4: scrub secrets out of the payload before the executor runs it.
  // The human approved a short DESCRIPTION, not the full body — a smuggled live
  // credential in an email body / write-file content must not exfiltrate past
  // that "yes". Redaction is fail-open and leaves benign text unchanged.
  const safePayload = isRegistry ? redactSecretsDeep(rec.payload) : rec.payload;
  const run = isRegistry
    ? executor
      ? () => executor(safePayload)
      : undefined
    : closure;

  if (!run) {
    // Should be unreachable (liveRecord checked runnability), but stay fail-open.
    return { ran: false, text: "Nothing is waiting on you." };
  }

  try {
    const text = await run();
    // Observability (audit finding 25): the confirm queue journaled only the
    // FILING, never the RUN — so tonight's four failures were invisible past the
    // generic spoken line. Journal every execution (the same mechanism the
    // confirm-filed line uses) so "what did you do" and a post-mortem can read it.
    journalConfirmOutcome(`confirm-executed:${rec.kind}`, rec.description);
    return {
      ran: true,
      text: typeof text === "string" && text.length > 0 ? text : "Done.",
    };
  } catch (executorError) {
    // A risky action failing must not throw into the turn; report it calmly —
    // but the REAL error (gws stderr packed by lib/gws.ts, an unknown-action
    // 400, …) must no longer die silently. Log it server-side AND journal a
    // trimmed copy so the next defect of this class is readable, not
    // reconstructed by hand (audit finding 25). Spoken text stays generic.
    const detail =
      executorError instanceof Error
        ? executorError.message
        : String(executorError);
    // eslint-disable-next-line no-console -- server-side diagnostics, never spoken
    console.error(
      `[confirm] executor for kind "${rec.kind}" threw:`,
      executorError
    );
    journalConfirmOutcome(`confirm-failed:${rec.kind}`, detail.slice(0, 200));
    return { ran: true, text: "I tried, but that didn't go through." };
  }
}

/** Journal a confirm run's outcome. Never throws — journaling must not break a
 *  turn — and the summary is redacted by appendJournal before it lands. */
function journalConfirmOutcome(tool: string, summary: string): void {
  try {
    appendJournal({ ts: Date.now(), threadId: "confirm", tool, summary });
  } catch {
    /* journaling must never break a confirm turn */
  }
}

/**
 * Cancel the pending action without running it. Reports whether there was
 * anything to cancel so the caller can phrase the reply. Clears the slot
 * whether it was fresh or already expired, so "cancel" always leaves the queue
 * empty.
 */
export function cancelPending(
  now: number = Date.now()
): { cancelled: boolean; text: string } {
  const wasLive = liveRecord(now) !== null;
  // liveRecord already cleared an expired/orphaned slot; clear a live one too.
  const rec = readRecord();
  if (rec) closureExecutors.delete(rec.pendingId);
  deleteRecord();

  return wasLive
    ? { cancelled: true, text: "Okay, cancelled." }
    : { cancelled: false, text: "There was nothing to cancel." };
}

// ---------------------------------------------------------------------------
// Server-side executor registration. The executors live in a separate module
// (lib/confirm-executors.ts) that imports registerExecutor from here — a
// circular import. To avoid the "Cannot access 'registry' before
// initialization" trap (a static side-effect import is hoisted above this
// module's own top-level `const registry`), we load the executors LAZILY on
// first use of any confirm-queue reader/writer. By then this module is fully
// initialized, and the dynamic import resolves the cycle cleanly. It runs once.
// ---------------------------------------------------------------------------
let executorsLoaded = false;
let executorsLoading: Promise<void> | null = null;

/**
 * Ensure the built-in executors are registered. Idempotent and cheap after the
 * first call. Awaited by confirmPending; the synchronous readers kick it off
 * fire-and-forget so a restart warms the registry before the confirm turn.
 */
export async function ensureExecutors(): Promise<void> {
  if (executorsLoaded) return;
  if (!executorsLoading) {
    executorsLoading = import("./confirm-executors.ts")
      .then(() => {
        executorsLoaded = true;
      })
      .catch(() => {
        // A failed executor import must not wedge the queue; retry next call.
        executorsLoading = null;
      });
  }
  await executorsLoading;
}

// Warm the registry as soon as this module is imported (fire-and-forget), so a
// process that just started has executors registered before the owner's confirm.
void ensureExecutors();
