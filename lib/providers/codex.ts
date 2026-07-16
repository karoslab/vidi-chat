import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { isKillEngaged, registerRun } from "../kill.ts";
import { appendQuota } from "../quota.ts";
import { WORKSPACE_ROOT } from "../workspace.ts";
import { scrubbedChildEnv } from "../child-env.ts";
import { markCodexWorkspaceTrusted } from "../agent-trust-presets.ts";
import { getUserConfig } from "../user-config.ts";
import { userRulesBlock } from "../user-rules.ts";
import { clampEffort, normalizeEffort, type Effort } from "../models.ts";
import type {
  BrainProvider,
  ProviderStreamEvent,
  RunUsage,
  SendMessageArgs,
} from "./types.ts";

/**
 * Codex provider — spawns OpenAI's `codex` CLI, authenticated with the owner's
 * ChatGPT subscription (`codex login`). No API key.
 *
 * Verified against codex-cli 0.142.4:
 *   - non-interactive mode: `codex exec --json <prompt>` emits JSONL events:
 *     {type:"thread.started",thread_id}, {type:"item.completed",item:{type,text,...}},
 *     {type:"turn.completed"} / {type:"turn.failed"}.
 *   - resume: `codex exec resume <thread_id> <prompt>` continues a session.
 *   - `--json` mode delivers the agent message as one completed item — no
 *     token-level deltas — so codex replies arrive as a single chunk.
 *   - item.type === "error" can be a benign warning (e.g. skills context
 *     budget); it is only fatal if the turn fails.
 *   - Persona: codex has no system-prompt flag, so VIDI_PERSONA.md is
 *     prepended to the first message of each thread; resumed turns already
 *     carry it in context.
 */

const REPO_ROOT = path.resolve(process.cwd());
const PERSONA_FILE = path.join(REPO_ROOT, "VIDI_PERSONA.md");
const WORK_DIR = WORKSPACE_ROOT;
const INACTIVITY_MS = 120_000;

function codexBin(): string {
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }
  const known = "/opt/homebrew/bin/codex";
  return existsSync(known) ? known : "codex";
}

function codexInstalled(): boolean {
  const bin = codexBin();
  if (bin !== "codex") return true;
  const pathDirs = (process.env.PATH || "").split(":");
  return pathDirs.some((d) => d && existsSync(path.join(d, "codex")));
}

/**
 * Selectable codex models. Slugs are the CLI-correct ids from the live catalog
 * (`~/.codex/config.toml` currently pins `gpt-5.6-luna`, and every turn resolves
 * against the same backend, so these are the ids the running CLI accepts —
 * `codex debug models` on an older binary only shows its stale local view).
 * "default" is the historical pseudo-model: no `-m` / no effort override, so the
 * turn runs at whatever `~/.codex/config.toml` resolves to (kept for back-compat
 * and for anyone who wants config-driven selection).
 * ("GPT-5.6 Terra" is the real product name — the owner's shorthand was "Tera".)
 */
const CODEX_MODEL_IDS = new Set([
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
]);

/**
 * Codex accepts all six effort strings LITERALLY (low/medium/high/xhigh/max/ultra
 * on `codex exec -c model_reasoning_effort=<v>`, verified live on 0.144.1 —
 * none are rejected), but each model has its own CEILING per its
 * supported_reasoning_levels. We clamp the chosen ladder level DOWN to the
 * model's ceiling so we never send a level the model would reject:
 *   gpt-5.5        low/medium/high/xhigh            → ceiling xhigh
 *   gpt-5.6-sol    low/medium/high/xhigh/max/ultra  → ceiling ultra
 *   gpt-5.6-terra  low/medium/high/xhigh/max/ultra  → ceiling ultra
 *   gpt-5.6-luna   low/medium/high/xhigh/max        → ceiling max
 */
const CODEX_EFFORT_CEILING: Record<string, Effort> = {
  "gpt-5.5": "xhigh",
  "gpt-5.6-sol": "ultra",
  "gpt-5.6-terra": "ultra",
  "gpt-5.6-luna": "max",
};

/** Resolve the codex reasoning level to pass via `-c model_reasoning_effort`, or
 *  undefined to leave it to config.toml. Only called for a real (non-"default")
 *  model, so CODEX_EFFORT_CEILING always has the modelId. Clamps the requested
 *  ladder level down to that model's ceiling. */
export function codexReasoningEffort(
  modelId: string,
  effort: string | undefined
): string | undefined {
  if (effort === undefined) return undefined; // absent → config.toml default
  const ceiling = CODEX_EFFORT_CEILING[modelId];
  if (!ceiling) return undefined;
  return clampEffort(normalizeEffort(effort), ceiling);
}

export const codexProvider: BrainProvider = {
  id: "codex",
  label: "Codex (ChatGPT)",
  models: [
    { id: "default", label: "Auto (Vidi routes)", default: true },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  ],

  async available() {
    if (!codexInstalled()) {
      return {
        ok: false,
        reason:
          "codex CLI not installed — `npm i -g @openai/codex` + `codex login`",
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
    if (!codexInstalled()) {
      yield {
        type: "error",
        message:
          "codex CLI not installed — `npm i -g @openai/codex` + `codex login`",
      };
      return;
    }

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
      // for EVERY provider — same block in claude.ts and grok.ts — so they
      // apply regardless of which model this turn runs on.
      const system = [userRulesBlock(), persona, args.extraSystemText]
        .filter(Boolean)
        .join("\n\n");
      if (system) {
        prompt = `<system>\n${system}\n</system>\n\n${getUserConfig().displayName} says: ${args.userMessage}`;
      }
    }

    const common = ["--json", "-s", "read-only", "--skip-git-repo-check", "-C", WORK_DIR];
    // Model + effort forwarding (was: never passed — every turn ran at the
    // config.toml default). Only a real catalog slug goes on the wire; "default"
    // or a stale/unknown id leaves both to ~/.codex/config.toml (historical
    // behavior). codex has no dedicated --effort flag, so reasoning effort rides
    // the generic `-c model_reasoning_effort=<level>` override (the value is
    // TOML-parsed with a raw-string fallback, so the bare level parses fine and
    // mirrors the config.toml key name).
    const requestedModel = typeof args.model === "string" ? args.model : undefined;
    if (requestedModel && CODEX_MODEL_IDS.has(requestedModel)) {
      common.push("-m", requestedModel);
      const level = codexReasoningEffort(
        requestedModel,
        typeof args.effort === "string" ? args.effort : undefined
      );
      if (level) common.push("-c", `model_reasoning_effort=${level}`);
    }
    const cliArgs = resuming
      ? ["exec", "resume", args.priorProviderSessionId!, ...common, prompt]
      : ["exec", ...common, prompt];

    // Pre-write the codex folder-trust marker for the workspace before launch,
    // so a fresh install never lands `codex exec` in a first-run trust gate
    // (Orca preset pattern). Best-effort: never fail a turn over it. Bounded to
    // WORK_DIR (the workspace root) by the module's assertTrustable guard.
    try {
      markCodexWorkspaceTrusted(WORK_DIR);
    } catch {
      /* trust pre-write is advisory — never fail a turn over it */
    }

    const child = spawn(codexBin(), cliArgs, {
      cwd: WORK_DIR,
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
            provider: "codex",
            startedAt: Date.now(),
          },
          child
        )
      : () => {};

    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    let threadId: string | null = args.priorProviderSessionId ?? null;
    let fullText = "";
    let lastMessageItemId: unknown;
    let turnFailed: string | null = null;
    let lastErrorItem = "";
    let usage: RunUsage | undefined;

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
          message: "codex CLI produced no output for 2 minutes — killed.",
        });
        finished = true;
        notify?.();
      }
    }, 5_000);

    // Abort (the explicit stop button, lib/turn-abort.ts): kill the child and
    // end the generator with a normal `done` carrying whatever text had
    // streamed so far, flagged `stopped` — a stop is not a failure. `codex
    // exec resume` continues the thread later if the user asks again, so
    // nothing durable is lost either way.
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      push({ type: "done", providerSessionId: threadId, fullText, usage, stopped: true });
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
      if (evt.type === "thread.started" && evt.thread_id) {
        threadId = evt.thread_id;
      } else if (evt.type === "item.completed" || evt.type === "item.updated") {
        const item = evt.item;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          // Whole message arrives at once; emit the unseen suffix.
          const sameItem = item.id !== undefined && item.id === lastMessageItemId;
          if (item.id !== undefined) lastMessageItemId = item.id;
          if (item.text.length > fullText.length && item.text.startsWith(fullText)) {
            push({ type: "delta", text: item.text.slice(fullText.length) });
            fullText = item.text;
          } else if (sameItem && item.text !== fullText) {
            // Revision of the SAME item that isn't a pure extension (shorter
            // or rewritten final). Appending would duplicate the draft; adopt
            // the revision for the persisted done text and let the live view
            // catch up there.
            fullText = item.text;
          } else if (item.text !== fullText) {
            push({ type: "delta", text: (fullText ? "\n\n" : "") + item.text });
            fullText += (fullText ? "\n\n" : "") + item.text;
          }
        } else if (item?.type === "error" && typeof item.message === "string") {
          lastErrorItem = item.message; // often benign; fatal only if turn fails
        }
      } else if (evt.type === "turn.completed") {
        // Quota ledger source: {usage:{input_tokens,cached_input_tokens,output_tokens}}
        // codex input_tokens INCLUDES cached tokens; normalize to the RunUsage
        // convention (inputTokens = non-cached) so windows sum comparably.
        const u = evt.usage;
        const rawInput = typeof u?.input_tokens === "number" ? u.input_tokens : undefined;
        const cached =
          typeof u?.cached_input_tokens === "number" ? u.cached_input_tokens : undefined;
        usage = {
          inputTokens:
            rawInput === undefined ? undefined : Math.max(0, rawInput - (cached ?? 0)),
          outputTokens:
            typeof u?.output_tokens === "number" ? u.output_tokens : undefined,
          cacheReadTokens: cached,
        };
      } else if (evt.type === "turn.failed") {
        turnFailed = evt.error?.message || lastErrorItem || "codex turn failed";
      } else if (evt.type === "error" && typeof evt.message === "string") {
        turnFailed = evt.message;
      }
    });

    child.on("close", (code) => {
      exitCode = code;
      finished = true;
      clearInterval(watchdog);
      notify?.();
    });
    child.on("error", (err) => {
      push({ type: "error", message: `failed to spawn codex CLI: ${err.message}` });
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

      // Ledger before the error check: an errored turn still burned quota.
      if (usage) {
        appendQuota({
          ts: Date.now(),
          provider: "codex",
          threadId: args.threadId,
          model: args.model ?? "default",
          // Callers normalize to plan|auto; legacy "act" kept for old ledgers.
          mode: args.mode === "auto" || args.mode === "act" ? "act" : "chat",
          ...usage,
        });
      }

      // onAbort already yielded its own done (with the partial text) and set
      // finished — exitCode is still null this tick, which would otherwise
      // misclassify a clean stop as "terminated by signal".
      if (aborted) return;

      // exitCode null after close = died to a signal (kill switch, external
      // kill) without a result — that is an error, not a silent partial done.
      if (turnFailed || exitCode !== 0) {
        const detail =
          turnFailed ||
          stderrTail.trim() ||
          (exitCode === null ? "terminated by signal" : `exit code ${exitCode}`);
        yield { type: "error", message: `codex CLI error: ${detail.slice(0, 500)}`, usage };
        return;
      }

      yield { type: "done", providerSessionId: threadId, fullText, usage };
    } finally {
      clearInterval(watchdog);
      args.signal?.removeEventListener("abort", onAbort);
      if (exitCode === null) child.kill("SIGKILL");
      unregister();
    }
  },
};
