import { detectBackends, hintFor } from "./credential-detect.ts";
import { brainRoot, isOwner } from "./user-config.ts";
import { isQuiet } from "./quiet.ts";
import { killStatus } from "./kill.ts";
import { getThread, listThreads } from "./store.ts";

/**
 * Fix-It Mode — the T0 (read-only) command registry (PLAN-VIDI-FIXIT.md §2, §6
 * Phase A).
 *
 * A non-owner second user (defaults to Plan mode) tells Vidi in plain language
 * that something's broken; Vidi maps that free text to ONE named command from
 * this fixed, server-side registry (lib/fixit-intents.ts does the mapping) and
 * runs the registered executor. THE REGISTRY IS THE SECURITY BOUNDARY: the
 * model can only ever propose a command id from the closed enum below; it can
 * never mutate config, run shell, or invent an action.
 *
 * This mirrors the `registerExecutor(kind, fn)` discipline of lib/confirm.ts,
 * but is a DELIBERATELY SEPARATE, SIBLING registry (§2 design rule): a fix-it
 * command can never be filed as a generic confirm action and vice-versa, so
 * this channel doesn't widen the forgeable B1 confirm path. Unlike confirm.ts
 * there is NO pending slot and NO approval here — every command in Phase A is
 * T0 read-only (§3.1), safe to run on match because the worst case is speaking
 * a status line.
 *
 * Design rules every executor obeys (§2):
 *  - NAMED + FIXED. The caller passes a `FixitCommandId` from the closed enum —
 *    never a path, a shell string, or free config.
 *  - BOUNDED BLAST RADIUS. A T0 executor touches only its declared read-only
 *    surface and returns plain-language spoken text. It NEVER throws into the
 *    turn — the worst case is a calm "I couldn't check that" line.
 *  - NO SECRET BYTES (§5, B5). No executor reads, echoes, or transports
 *    credential file CONTENTS. `creds.recheck` reports connection status only
 *    (a boolean + label + plain-language hint from credential-detect.ts), never
 *    token bytes; `status.whatsMySetup` reports login status the same way.
 */

/**
 * The closed enum of Phase A (T0) command ids. Adding a T1/T2 command in a
 * later phase extends this union AND registers its executor below — an id with
 * no registered executor can never run (see `runFixitCommand`).
 */
export type FixitCommandId =
  | "status.whatsMySetup"
  | "creds.recheck"
  | "brain.verify";

/**
 * A fix-it executor: a pure-ish async function that reads its declared surface
 * and returns plain-language SPOKEN text. It takes no free arguments in Phase A
 * (every T0 command is a fixed read-only probe). It must never throw — each
 * body is wrapped so a surprise resolves to a calm spoken line, not an
 * exception in the voice turn.
 */
type FixitExecutor = () => Promise<string>;

/** id → executor. Populated by `registerFixitExecutor` at module load (below). */
const registry = new Map<FixitCommandId, FixitExecutor>();

/**
 * Register a server-side executor for a fix-it command id. Called once per id
 * at module load. A later registration overrides an earlier one (last wins),
 * which keeps hot-reload sane in dev — same discipline as confirm.ts.
 */
export function registerFixitExecutor(id: FixitCommandId, fn: FixitExecutor): void {
  registry.set(id, fn);
}

/** True iff `id` is a registered, runnable fix-it command. */
export function isFixitCommand(id: string): id is FixitCommandId {
  return registry.has(id as FixitCommandId);
}

/**
 * Run a fix-it command by id and resolve to its spoken text. ONLY a registered
 * id runs — an unknown/unregistered id resolves to a calm "I don't know how to
 * do that" line and NEVER executes anything (the registry is the boundary). An
 * executor that somehow throws is caught here too, so a fix-it command can
 * never break a voice turn.
 */
export async function runFixitCommand(id: string): Promise<string> {
  const executor = registry.get(id as FixitCommandId);
  if (!executor) {
    return "I don't know how to do that one.";
  }
  try {
    return await executor();
  } catch {
    return "I tried to check that, but something got in the way.";
  }
}

/* -------------------------------------------------------------------------- */
/* T0 executors — read-only, no approval (§2.1 rows 1/4/7, §3.1)              */
/* -------------------------------------------------------------------------- */

/**
 * `status.whatsMySetup` (§2.1 row 1) — the triage entry point. Speaks the
 * current mode/model/effort, backend login status (via detectBackends()),
 * brain dir, kill-switch state, quiet mode, and owner flag. READ-ONLY, and NO
 * secret contents (B5): only login booleans + labels, never token bytes.
 *
 * The voice thread's mode/model/effort are READ directly from store.ts (which
 * uses relative imports and so is safe to import statically here — voice-turn.ts
 * imports THIS registry, so importing back would be a cycle). We read the voice
 * thread without CREATING one — a status probe must have no side effects, so an
 * install that has never run a voice turn just reports the shipped defaults.
 */
registerFixitExecutor("status.whatsMySetup", async () => {
  const parts: string[] = [];

  // Mode / model / effort off the existing voice thread, if any. Read-only:
  // never creates the thread (unlike findOrCreateVoiceThread) so this probe is
  // side-effect free; absent → the shipped defaults.
  try {
    const VOICE_THREAD_TITLE = "voice";
    const meta = listThreads().find(
      (candidate) => candidate.title === VOICE_THREAD_TITLE && candidate.provider === "claude"
    );
    const thread = meta ? getThread(meta.id) : null;
    const mode = thread?.mode === "auto" || thread?.mode === "act" ? "Auto" : "Plan";
    const model =
      typeof thread?.model === "string" && thread.model.length > 0 && thread.model !== "auto"
        ? thread.model
        : "auto-routed";
    const effort =
      typeof thread?.effort === "string" && thread.effort.length > 0 ? thread.effort : "medium";
    parts.push(`You're in ${mode} mode, model ${model}, effort ${effort}.`);
  } catch {
    parts.push("I couldn't read the current mode.");
  }

  // Backend login status — booleans + labels only, never token bytes (B5).
  try {
    const backends = await detectBackends();
    const backendLine = backends
      .map((backend) =>
        backend.loggedIn ? `${backend.label} is connected` : `${backend.label} is not connected`
      )
      .join(", ");
    parts.push(`${backendLine}.`);
  } catch {
    parts.push("I couldn't check the backend logins.");
  }

  // Brain dir — the path only, no contents.
  try {
    parts.push(`My brain folder is ${brainRoot()}.`);
  } catch {
    parts.push("I couldn't locate my brain folder.");
  }

  // Kill-switch state.
  try {
    const kill = killStatus();
    parts.push(kill.engaged ? "The kill switch is engaged." : "The kill switch is off.");
  } catch {
    /* omit rather than guess */
  }

  // Quiet mode.
  try {
    parts.push(isQuiet() ? "Quiet mode is on." : "Quiet mode is off.");
  } catch {
    /* omit rather than guess */
  }

  // Owner flag.
  try {
    parts.push(isOwner() ? "You're set up as the owner." : "You're set up as a guest user.");
  } catch {
    /* omit rather than guess */
  }

  return parts.join(" ");
});

/**
 * `creds.recheck` (§2.1 row 4) — re-run the detectBackends() liveness probe
 * (`claude auth status` / `codex login status`, zero tokens, no secret bytes)
 * and report green/red per backend plus the plain-language hintFor() fix. NO
 * approval (T0). Reports connection STATUS only (B5) — never a token byte.
 */
registerFixitExecutor("creds.recheck", async () => {
  const backends = await detectBackends();
  const lines = backends.map((backend) => {
    if (backend.loggedIn) {
      return `${backend.label} is connected.`;
    }
    // hintFor() is plain-language and safe to speak verbatim — never raw stderr.
    const hint = backend.hint ?? hintFor(backend.id, backend.installed, backend.loggedIn);
    return hint
      ? `${backend.label} isn't connected. ${hint}`
      : `${backend.label} isn't connected.`;
  });
  return lines.join(" ");
});

/**
 * `brain.verify` (§2.1 row 7) — read-only: report brainRoot(), whether it
 * exists/readable, and the note count. RE-POINTING the brain dir is NOT a
 * fix-it command (O4, §2.2): this only READS. The note count is the number of
 * "remember this" notes under <brainRoot>/vidi/notes (the same dir lib/recent.ts
 * reads); a missing dir is a valid zero, not an error.
 */
registerFixitExecutor("brain.verify", async () => {
  // Lazy fs import keeps this module's top clean and matches the read-only,
  // no-throw posture — any fs surprise falls through to the calm line below.
  const fs = await import("node:fs");
  const path = await import("node:path");

  const root = brainRoot();
  const exists = fs.existsSync(root);
  if (!exists) {
    return `My brain folder is ${root}, but I can't find it right now — it may have moved.`;
  }

  let readable = true;
  try {
    fs.accessSync(root, fs.constants.R_OK);
  } catch {
    readable = false;
  }
  if (!readable) {
    return `My brain folder is ${root}. It's there, but I can't read it right now.`;
  }

  // Count the "remember this" notes — a read-only signal that memory is intact.
  let noteCount = 0;
  try {
    const notesDir = path.join(root, "vidi", "notes");
    if (fs.existsSync(notesDir)) {
      noteCount = fs
        .readdirSync(notesDir)
        .filter((fileName) => fileName.endsWith(".md")).length;
    }
  } catch {
    /* an unreadable notes dir just reports zero notes, never an error */
  }

  const noteWord = noteCount === 1 ? "note" : "notes";
  return `My brain folder is ${root}, it's there and readable, with ${noteCount} ${noteWord} saved.`;
});
