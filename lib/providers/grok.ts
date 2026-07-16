import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { isKillEngaged, registerRun } from "../kill.ts";
import { appendQuota } from "../quota.ts";
import { scrubbedChildEnv } from "../child-env.ts";
import { getUserConfig } from "../user-config.ts";
import { userRulesBlock } from "../user-rules.ts";
import { clampEffort, normalizeEffort } from "../models.ts";
import type {
  BrainProvider,
  ProviderStreamEvent,
  SendMessageArgs,
} from "./types.ts";

/**
 * Grok provider — spawns xAI's `grok` CLI ("Grok Build TUI"), authenticated with
 * the owner's Grok subscription (`grok login`, auth_method "session"). No API key.
 *
 * Verified against grok 0.2.54 (headless `-p` mode, --output-format streaming-json):
 *   - streaming-json emits newline-delimited events, each a self-contained object:
 *       {type:"text",data:"..."}    -> a chunk of the answer (real token deltas)
 *       {type:"thought",data:"..."} -> internal reasoning (thinking tokens)
 *       {type:"end",stopReason,sessionId,requestId} -> final metadata
 *       {type:"error",message}      -> a failure (also non-zero exit)
 *     Unknown types (max_turns_reached, auto_compact_*) are ignored — the list
 *     is documented as non-exhaustive.
 *   - resume: `grok -p <prompt> -r <sessionId>` continues that session (the
 *     `end` event's sessionId; a resumed turn keeps the same id). A stale id
 *     errors with "Couldn't create session: Session does not exist" + exit 1.
 *   - CONFINEMENT is three independent controls, each with an honest scope. The
 *     earlier `--sandbox read-only` + `--disallowed-tools run_terminal_cmd` combo
 *     was NOT safe: a fresh-context audit proved (live, grok 0.2.54) that under
 *     read-only grok's own read_file still read any secret on disk, its in-process
 *     web_fetch made real outbound HTTPS, and a background-task shell path reached
 *     the network even with run_terminal_cmd denied (the tool is also named
 *     `run_terminal_command`, so the single deny missed it). The three controls:
 *
 *       1. WRITE boundary — `--sandbox strict` (Seatbelt, kernel-enforced) run
 *          with `--cwd` pointed at an empty throwaway jail dir (SANDBOX_CWD, under
 *          the OS temp dir, OUTSIDE the workspace). strict writes only to CWD +
 *          ~/.grok/ + temp; since CWD is the empty jail, the workspace and $HOME
 *          are NOT writable. A workspace write fails with `os error 1`. This is a
 *          real kernel boundary and does not depend on grok's own permission gate
 *          (this box's ~/.grok/config.toml defaults permission_mode to
 *          "always-approve", so grok's prompt gate is worthless here).
 *
 *       2. READ boundary — TWO layers, honest about what each covers. Verified
 *          live from ~/.grok/sandbox-events.jsonl (ProfileApplied, macos/seatbelt,
 *          enforced:true), the `strict` KERNEL profile denies the $HOME root, the
 *          workspace, ~/.ssh, ~/.aws, ~/.codex — but GRANTS ~/.grok read-write and
 *          ~/Library read-only at the kernel level. So the sandbox alone does NOT
 *          protect grok's own live credential (~/.grok/auth.json: refresh_token +
 *          access JWT) or ~/Library/Keychains — a strict-sandboxed grok with a
 *          read tool CAN read them (proven: it read auth.json and printed the
 *          token). That is exactly WHY the real read boundary is the TOOL ALLOWLIST
 *          (control 3 / GROK_ALLOWED_TOOLS): grok is given no read_file/list_dir at
 *          all, so it has no way to open those kernel-readable paths. The kernel
 *          strict profile still adds value for the paths it DOES deny (workspace +
 *          $HOME root + ~/.ssh/.aws/.codex) as defense in depth, and `strict` is a
 *          built-in profile grok will NOT let a user ~/.grok/sandbox.toml redefine.
 *          (Grok loses legitimate workspace reads too — acceptable: the persona is
 *          injected in-process by this server, never read by grok.)
 *
 *       3. NETWORK/egress — there is NO kernel network boundary for grok on macOS.
 *          `restrict_network` is documented (and confirmed live) as a Linux-only
 *          no-op on macOS, and in-process HTTP tools (web_fetch, web_search) are
 *          never blocked by it on ANY platform. So egress is closed by TOOL scope,
 *          not the sandbox: `--tools todo_write` is an ALLOWLIST of one harmless
 *          non-fs/non-net tool, so there is no web/shell/monitor/subagent/
 *          scheduler/image tool to reach the network with (and no read tool to
 *          reach a secret with either — see control 2). Belt-and-suspenders on
 *          top: `--disallowed-tools` names every egress/escalation tool (both
 *          shell names, web_fetch/web_search, the x_* search tools, image_gen,
 *          spawn_subagent, use_tool, monitor), plus `--disable-web-search` and
 *          `--no-subagents` (a subagent could otherwise carry its own shell tool
 *          not covered by the parent's tool scope). Re-verified live: an ipify
 *          fetch returns NO_NETWORK and a read-then-POST exfil attempt fails.
 *          Residual: grok's own turn still reaches xAI's backend in-process (it
 *          must, to answer) — content grok legitimately handles reaches xAI, which
 *          is THREAT_MODEL B5 accepted risk. What B5 does NOT accept — secrets
 *          POSTed to an attacker endpoint — is closed by controls 2 + 3.
 *
 *     `--permission-mode plan` is used ONLY for the "Chat" posture (FIX 3): it is
 *     a documented permission value on 0.2.93 and only ever equal-or-more
 *     restrictive than the default, so it never loosens the sandbox. "Build"
 *     (the default) passes no permission-mode, matching the historical behavior.
 *   - Persona: grok's `--system-prompt-override` REPLACES the whole system
 *     prompt (losing grok's tool/skill scaffolding), so instead — like codex —
 *     VIDI_PERSONA.md is prepended to the first message of each session; resumed
 *     turns already carry it in context.
 *   - No token usage: neither the json nor streaming-json headless output reports
 *     token counts, so the quota ledger records the turn (numTurns/durationMs)
 *     without token fields.
 */

const REPO_ROOT = path.resolve(process.cwd());
const PERSONA_FILE = path.join(REPO_ROOT, "VIDI_PERSONA.md");
const INACTIVITY_MS = 120_000;
/** The one real grok model this provider is audited for. Both selectable ids
 *  (Chat / Build) run on it — they differ only by AGENT POSTURE, never model or
 *  sandbox (see resolveGrokModel + the confinement header). */
const GROK_WIRE_MODEL = "grok-4.5";

/**
 * The two selectable Grok ids (FIX 3). Both map to the same grok-4.5 model on
 * the wire and the SAME confinement (strict sandbox + one-tool allowlist +
 * denylist + jail cwd + --no-subagents — see the header); they differ ONLY by
 * agent POSTURE:
 *   - build (default, = the historical behavior): the agentic build posture.
 *     No --permission-mode; keeps the todo_write planning tool. Existing threads
 *     (stored model "grok-4.5" / "default" / anything unrecognized) resolve here,
 *     so nothing pre-existing changes.
 *   - chat: a lighter conversational posture. Adds `--permission-mode plan`
 *     (documented plan value on grok 0.2.93 — only ever equal-or-MORE
 *     restrictive than default, so the sandbox is provably unchanged) and a
 *     concise chat framing line in the injected system block.
 * The id (chat vs build) is what the thread persists, so it is part of the FIX-1
 * session fingerprint — switching Chat↔Build changes the fingerprint and forces
 * a fresh session, which grok's agent switch requires anyway.
 */
export type GrokAgentMode = "chat" | "build";
export interface ResolvedGrokModel {
  /** Model id passed to `-m` — always the single audited grok-4.5. */
  wireModel: string;
  /** Agent posture. */
  agentMode: GrokAgentMode;
  /** Whether to pass `--permission-mode plan` (chat only). */
  planMode: boolean;
}

const GROK_MODEL_CHAT = "grok-4.5-chat";
const GROK_MODEL_BUILD = "grok-4.5-build";

/** Map a stored/selected model id to the wire model + agent posture. Only the
 *  exact "grok-4.5-chat" id is Chat; everything else — the Build id, the legacy
 *  "grok-4.5", "default"/"auto", or a stale grok-composer id — resolves to Build
 *  so a resumed older thread never tries an incompatible model switch. Pure +
 *  exported for unit tests. */
export function resolveGrokModel(id: string | null | undefined): ResolvedGrokModel {
  const agentMode: GrokAgentMode = id === GROK_MODEL_CHAT ? "chat" : "build";
  return {
    wireModel: GROK_WIRE_MODEL,
    agentMode,
    planMode: agentMode === "chat",
  };
}

/**
 * Empty throwaway jail dir used as grok's `--cwd`. Under `--sandbox strict` the
 * workspace CWD is a writable + readable location, so keeping the CWD an empty
 * dir OUTSIDE the workspace is what makes the workspace non-writable AND its
 * secrets non-readable at the kernel. It lives under the OS temp dir (which strict
 * already treats as writable), never inside the repo. (Note: strict still grants
 * ~/.grok RW and ~/Library RO at the kernel regardless of CWD — those paths are
 * covered by removing grok's read tools, not by the sandbox; see the header.)
 */
const SANDBOX_CWD = path.join(os.tmpdir(), "vidi-grok-sandbox");

/**
 * Tool ALLOWLIST — the primary confinement control (see the header comment,
 * controls 2 + 3). Grok is a read-only CHAT brain whose persona is injected
 * in-process by this server (prepended to the first message), so it needs NO
 * filesystem read tools at all. `todo_write` is a single harmless in-session
 * task-list tool — neither filesystem nor network — kept only because grok
 * treats an EMPTY `--tools ""` as "use the DEFAULT toolset" (which re-enables
 * read_file: verified live on 0.2.54, empty allowlist still read ~/.grok/auth.json
 * and printed the token). A one-tool non-fs/non-net allowlist is the tightest set
 * grok honors: no read_file/list_dir (so it cannot read ~/.grok credentials,
 * ~/Library/Keychains, or any $HOME/workspace secret), and no shell/web/monitor/
 * subagent/scheduler/image/x-search tool to reach the network with.
 */
const GROK_ALLOWED_TOOLS = "todo_write";

/**
 * Tool DENYLIST — belt-and-suspenders over the allowlist. Names every egress /
 * privilege-escalation tool a fresh-context audit found on grok 0.2.54, including
 * BOTH documented shell names (`run_terminal_cmd` and `run_terminal_command`), the
 * background-task `monitor` shell path, and the `use_tool` meta-tool. Scheduler
 * tools are intentionally omitted here (denying one triggers a grok requirements
 * error) — the allowlist already excludes them.
 */
const GROK_DENIED_TOOLS = [
  "run_terminal_command",
  "run_terminal_cmd",
  "web_fetch",
  "web_search",
  "x_user_search",
  "x_semantic_search",
  "x_keyword_search",
  "x_thread_fetch",
  "image_gen",
  "spawn_subagent",
  "use_tool",
  "monitor",
].join(",");

/** vidi effort ladder -> grok `--reasoning-effort` level. Grok accepts
 *  low/medium/high/xhigh/max (it has the extra "xhigh" tier and calls the top
 *  "max"); the ladder's top "ultra" clamps to max, everything else passes
 *  through 1:1. Never sends a level grok would reject. Exported for unit tests. */
export function grokEffort(effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined;
  return clampEffort(normalizeEffort(effort), "max");
}

function grokBin(): string {
  if (process.env.GROK_BIN && existsSync(process.env.GROK_BIN)) {
    return process.env.GROK_BIN;
  }
  const known = `${process.env.HOME || ""}/.grok/bin/grok`;
  return existsSync(known) ? known : "grok";
}

function grokInstalled(): boolean {
  const bin = grokBin();
  if (bin !== "grok") return true;
  const pathDirs = (process.env.PATH || "").split(":");
  return pathDirs.some((d) => d && existsSync(path.join(d, "grok")));
}

export const grokProvider: BrainProvider = {
  id: "grok",
  label: "Grok (xAI)",
  // Two selectable ids, BOTH on the single audited grok-4.5 model (see
  // resolveGrokModel): "Build" is the historical agentic posture (default, so
  // existing threads are unchanged), "Chat" a lighter conversational posture
  // (--permission-mode plan + a chat framing line). Grok's OTHER models
  // (grok-composer-2.5-fast) require a different agent ('cursor') outside this
  // provider's confinement audit and would fail an incompatible-agent switch on
  // a resumed session, so they stay excluded — Chat/Build never change the model
  // or the sandbox, only the agent posture.
  models: [
    { id: GROK_MODEL_BUILD, label: "Grok 4.5 Build", default: true },
    { id: GROK_MODEL_CHAT, label: "Grok 4.5 Chat" },
  ],

  async available() {
    if (!grokInstalled()) {
      return {
        ok: false,
        reason: "grok CLI not installed — install the Grok CLI + `grok login`",
      };
    }
    return { ok: true };
  },

  async *sendMessage(args: SendMessageArgs): AsyncGenerator<ProviderStreamEvent> {
    if (isKillEngaged()) {
      yield {
        type: "error",
        message:
          "kill switch is engaged — say 'clear the kill switch' or delete data/KILL",
      };
      return;
    }
    if (!grokInstalled()) {
      yield {
        type: "error",
        message: "grok CLI not installed — install the Grok CLI + `grok login`",
      };
      return;
    }

    // Resolve the selected id → wire model + agent posture (Chat vs Build). The
    // wire model is always the single audited grok-4.5, so a resumed session
    // never tries an incompatible-agent model switch; "default"/"auto"/legacy
    // ids resolve to Build (the historical behavior).
    const resolved = resolveGrokModel(args.model);
    const modelId = resolved.wireModel;

    // Identity line — grok self-reports "4.3" (unreliable self-knowledge); it IS
    // grok-4.5. Plus a mode-specific posture line so Chat vs Build is an
    // observable difference on top of --permission-mode.
    const posture =
      resolved.agentMode === "chat"
        ? "You are Grok 4.5, running as a conversational assistant. Answer directly and concisely; do not attempt to modify files or run commands."
        : "You are Grok 4.5, running as a build/agent assistant. Reason through the task and give complete, actionable answers.";

    let prompt = args.userMessage;
    const resuming = Boolean(args.priorProviderSessionId);
    if (!resuming) {
      let persona = "";
      try {
        persona = readFileSync(PERSONA_FILE, "utf8");
      } catch {
        /* persona file missing — proceed without it */
      }
      // standing rules (lib/user-rules.ts) prepend the system block
      // for EVERY provider — same block in claude.ts and codex.ts — so they
      // apply regardless of which model this turn runs on.
      const system = [userRulesBlock(), persona, posture, args.extraSystemText]
        .filter(Boolean)
        .join("\n\n");
      if (system) {
        prompt = `<system>\n${system}\n</system>\n\n${getUserConfig().displayName} says: ${args.userMessage}`;
      }
    }

    // Confinement (see the header comment for the full audit-driven rationale):
    //   --sandbox strict + --cwd <empty jail>  → kernel write + workspace/$HOME-root
    //                                            read boundary (NOT ~/.grok, ~/Library)
    //   --tools <one non-fs/non-net tool>       → primary read AND egress boundary
    //                                            (no read tool ⇒ no secret read at all)
    //   --disallowed-tools / --disable-web-search / --no-subagents → belt
    // Grok ignores args.mode entirely — it never gets write/act, mirroring codex.
    // The jail dir must exist before spawn or grok errors on an unknown cwd.
    mkdirSync(SANDBOX_CWD, { recursive: true });
    const cliArgs = [
      "-p",
      prompt,
      "--output-format",
      "streaming-json",
      "-m",
      modelId,
      "--sandbox",
      "strict",
      "--tools",
      GROK_ALLOWED_TOOLS,
      "--disallowed-tools",
      GROK_DENIED_TOOLS,
      "--disable-web-search",
      "--no-subagents",
      "--cwd",
      SANDBOX_CWD,
      "--no-auto-update",
    ];
    // Chat posture only: plan permission-mode is a documented value on 0.2.93 and
    // is only ever equal-or-MORE restrictive than the default — the confinement
    // (sandbox + tool allow/deny lists + jail cwd) is byte-identical to Build.
    if (resolved.planMode) cliArgs.push("--permission-mode", "plan");
    const effort = grokEffort(args.effort);
    if (effort) cliArgs.push("--reasoning-effort", effort);
    if (resuming) cliArgs.push("-r", args.priorProviderSessionId!);

    const startedAt = Date.now();
    const child = spawn(grokBin(), cliArgs, {
      // Process cwd = the same empty jail dir passed as --cwd, so grok's notion of
      // the project dir and its sandbox scope agree (nothing sensitive under it).
      cwd: SANDBOX_CWD,
      stdio: ["ignore", "pipe", "pipe"],
      // args.childEnv carries the fleet's VIDI_AGENT_ID/DEPTH stamp (H10).
      // Tier-2 (S-env): scrubbed allowlisted env, not the full process.env.
      env: scrubbedChildEnv(args.childEnv ?? {}),
    });

    // Kill-switch registry — engageKill() SIGKILLs everything registered.
    const unregister = child.pid
      ? registerRun(
          {
            pid: child.pid,
            threadId: args.threadId,
            provider: "grok",
            startedAt: Date.now(),
          },
          child
        )
      : () => {};

    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    let sessionId: string | null = args.priorProviderSessionId ?? null;
    let fullText = "";
    let reasoned = false;
    let turnFailed: string | null = null;
    let staleSession = false;

    const queue: ProviderStreamEvent[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    let exitCode: number | null = null;

    const push = (ev: ProviderStreamEvent) => {
      queue.push(ev);
      notify?.();
    };

    let lastActivity = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > INACTIVITY_MS) {
        child.kill("SIGKILL");
        push({
          type: "error",
          message: "grok CLI produced no output for 2 minutes — killed.",
        });
        finished = true;
        notify?.();
      }
    }, 5_000);

    // Abort (the explicit stop button, lib/turn-abort.ts): kill the child and
    // end the generator with a normal `done` carrying whatever text had streamed
    // so far, flagged `stopped` — a stop is not a failure. `grok -r <sessionId>`
    // continues the session later if the user asks again, so nothing durable is
    // lost either way.
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      push({ type: "done", providerSessionId: sessionId, fullText, stopped: true });
      finished = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      notify?.();
    };
    if (args.signal?.aborted) onAbort();
    else args.signal?.addEventListener("abort", onAbort, { once: true });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      lastActivity = Date.now();
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let evt: any;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (evt.type === "text" && typeof evt.data === "string") {
        if (evt.data.length > 0) {
          push({ type: "delta", text: evt.data });
          fullText += evt.data;
        }
      } else if (evt.type === "thought") {
        // Honest "reasoning happened" signal — emit once per turn, never the
        // redacted thinking text itself (grok streams thought verbatim, but the
        // UI contract carries only the boolean, matching the claude provider).
        if (!reasoned) {
          reasoned = true;
          push({ type: "reasoning", reasoned: true });
        }
      } else if (evt.type === "end") {
        if (typeof evt.sessionId === "string") sessionId = evt.sessionId;
      } else if (evt.type === "error" && typeof evt.message === "string") {
        turnFailed = evt.message;
        // A rejected resume ("Couldn't create session: Session does not exist"):
        // the stored id is stale, so tell the caller to null it and start clean.
        if (resuming && /session (does not exist|not found)/i.test(evt.message)) {
          staleSession = true;
        }
      }
      // Unknown types (max_turns_reached, auto_compact_*) are ignored.
    });

    child.on("close", (code) => {
      exitCode = code;
      finished = true;
      clearInterval(watchdog);
      notify?.();
    });
    child.on("error", (err) => {
      push({ type: "error", message: `failed to spawn grok CLI: ${err.message}` });
      finished = true;
      clearInterval(watchdog);
      notify?.();
    });

    try {
      while (true) {
        while (queue.length > 0) {
          const ev = queue.shift()!;
          yield ev;
          if (ev.type === "error") return;
        }
        if (finished) break;
        await new Promise<void>((resolve) => (notify = resolve));
        notify = null;
      }

      // onAbort already yielded its own done (with the partial text) and set
      // finished — exitCode is still null this tick, which would otherwise
      // misclassify a clean stop as "terminated by signal".
      if (aborted) return;

      // Ledger: grok headless reports no token counts, so record that a turn
      // happened (provider/model/mode + duration) without token fields.
      appendQuota({
        ts: Date.now(),
        provider: "grok",
        threadId: args.threadId,
        model: modelId,
        // Callers normalize to plan|auto; grok is always read-only ("chat").
        mode: "chat",
        durationMs: Date.now() - startedAt,
        numTurns: 1,
      });

      // exitCode null after close = died to a signal (kill switch, external
      // kill) without a result — that is an error, not a silent partial done.
      if (turnFailed || exitCode !== 0) {
        const detail =
          turnFailed ||
          stderrTail.trim() ||
          (exitCode === null ? "terminated by signal" : `exit code ${exitCode}`);
        yield {
          type: "error",
          message: `grok CLI error: ${detail.slice(0, 500)}`,
          ...(staleSession ? { resetProviderSession: true as const } : {}),
        };
        return;
      }

      yield { type: "done", providerSessionId: sessionId, fullText };
    } finally {
      clearInterval(watchdog);
      args.signal?.removeEventListener("abort", onAbort);
      if (exitCode === null) child.kill("SIGKILL");
      unregister();
    }
  },
};
