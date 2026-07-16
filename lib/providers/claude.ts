import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { isKillEngaged, registerRun } from "../kill.ts";
import { appendLive, clearLive } from "../live-buffer.ts";
import { normalizeMode, recordFableObservation, resolveRun } from "../models.ts";
import { appendQuota } from "../quota.ts";
import { foldReasoningSignal, type ReasoningSignal } from "./reasoning-signal.ts";
import { shouldRetryWithoutResume } from "./claude-retry.ts";
import { isLimitError, isLoginError } from "./claude-failover.ts";
import { isNetworkError, shouldRetryNetwork, FRIENDLY_NETWORK_MESSAGE } from "./claude-network.ts";
import {
  expandConfigDir,
  getActiveAccount,
  enabledAccounts,
  setActiveAccountId,
  type Account,
} from "../accounts.ts";
import { appendJournal } from "../journal.ts";
import { scrubbedChildEnv } from "../child-env.ts";
import { dataDir } from "../data-dir.ts";
import { markClaudeWorkspaceTrusted } from "../agent-trust-presets.ts";
import { WORKSPACE_ROOT, workspacePath } from "../workspace.ts";
import { actModeAllowed, brainRoot, getUserConfig, isOwner } from "../user-config.ts";
import { userRulesBlock } from "../user-rules.ts";
import {
  SECOND_OPINION_ALLOWED_TOOLS,
  writeSecondOpinionsMcpConfig,
} from "../mcp/second-opinions-config.ts";
import type {
  BrainProvider,
  ProviderStreamEvent,
  RunUsage,
  SendMessageArgs,
} from "./types.ts";

/**
 * Claude Max provider — spawns the locally-authenticated `claude` CLI in
 * non-interactive print mode. Runs on the owner's subscription; no API key.
 *
 * Verified against claude CLI 2.1.195:
 *   - `--output-format stream-json` in print mode requires `--verbose`.
 *   - stream events: {type:"system",subtype:"init",session_id}, then
 *     {type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text}}},
 *     plus {type:"assistant",message:{content:[{type:"tool_use",id,name,input}]}}
 *     per tool call, finally {type:"result",subtype:"success",result,session_id}.
 *   - stdin must be ignored or the CLI waits 3s for piped input.
 *
 * Act mode trust dial — every claim below was tested empirically on 2.1.195
 * (2026-07-01) before wiring:
 *   - `--setting-sources project` is LOAD-BEARING. Without it the spawned CLI
 *     merges ~/.claude/settings.json, which blanket-allows Bash/Edit/Write on
 *     this machine — the whole jail evaporates. `project` keeps only
 *     project-level settings under the workspace, not the machine-wide allow-all.
 *   - Granular Bash allow rules like `Bash(git *)` work headless: `git …` ran,
 *     `touch …` was auto-denied (shows up in permission_denials).
 *   - Write/Edit are directory-jailed to cwd + --add-dir: a Write to
 *     ~/Desktop was denied with only the workspace root added.
 *   - A blanket `Read` allow rule is NOT directory-jailed: reads outside
 *     the workspace (e.g. a memory/brain dir) still work when --add-dir allows
 *     them. Intentional — Vidi keeps a knowledge manifest in act mode; only
 *     mutations are jailed.
 *   - Deny path rules hold with `//abs/path`, `~/path`, and `**` globs.
 *     A single-slash absolute path (`Read(/Users/…)`) silently matches
 *     NOTHING — never use that form.
 */

const REPO_ROOT = path.resolve(process.cwd());
const PERSONA_FILE = path.join(REPO_ROOT, "VIDI_PERSONA.md");
// The owner persona carries the owner's biography and machine layout; a
// customer install must NEVER ship an owner-specific voice. Non-owner installs
// read the generic persona, falling back to the owner file only if the
// customer file is missing from a stale payload.
const PERSONA_FILE_CUSTOMER = path.join(REPO_ROOT, "VIDI_PERSONA_CUSTOMER.md");
function personaFile(): string {
  if (!isOwner() && existsSync(PERSONA_FILE_CUSTOMER)) return PERSONA_FILE_CUSTOMER;
  return PERSONA_FILE;
}
const WORK_DIR = WORKSPACE_ROOT;
// The two direct-write user dirs. A write here is fine; a write anywhere else
// outside the jail routes through vidi-act write-file → confirm.
const HOME_DIR = process.env.HOME || getUserConfig().homeDir;
const DESKTOP_DIR = path.join(HOME_DIR, "Desktop");
const DOWNLOADS_DIR = path.join(HOME_DIR, "Downloads");
const INACTIVITY_MS = 120_000;

// Skill lets typed /commands (e.g. /swarm) resolve from workspace `.claude/skills`;
// the skill's underlying tool calls are still gated by these same allowlists.
export const CHAT_ALLOWED_TOOLS = "Read,Grep,Glob,Skill";
const CHAT_DISALLOWED_TOOLS =
  "Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task";

/** Act mode: read-only set + Edit/Write + a Bash prefix allowlist. */
export const ACT_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "Skill",
  "Bash(git *)",
  // GitHub CLI so the branch→PR workflow works headless (gh pr create etc.).
  // Destructive/secret-leaking gh verbs are on the deny list below.
  "Bash(gh *)",
  "Bash(npm *)",
  "Bash(npx *)",
  "Bash(bun *)",
  // Tier-2 (B3): raw `Bash(node *)` and `Bash(python3 *)` are REMOVED. A raw
  // interpreter is an arbitrary-code escape that defeats the whole prefix
  // allowlist — e.g. `node bin/vidictl.mjs shell "<anything>"` reached the
  // control plane's spawn(cmd,{shell:true}) with no confirm (threat-model B3).
  // vidi-act still runs (it's on PATH as `vidi-act`, admitted by Bash(vidi-act *)
  // below, not by node), and the build/PR workflow keeps npm/npx/bun. Residual
  // interpreters (npx/bun) are the Tier-3 tree-sitter decomposition's job.
  "Bash(ls *)",
  "Bash(mkdir *)",
  "Bash(mv *)",
  "Bash(cp *)",
  "Bash(touch *)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(pwd)",
  "Bash(which *)",
  // gbrain READ surface only (if the operator uses gbrain) —
  // put/delete/import stay off the list.
  "Bash(gbrain search *)",
  "Bash(gbrain query *)",
  "Bash(gbrain ask *)",
  "Bash(gbrain get *)",
  "Bash(gbrain list *)",
  // The action chokepoint (bin/vidi-act, symlinked onto PATH). Safe verbs run
  // direct; risky verbs file a confirm and refuse — the shim IS the gate, so
  // allowing it is allowing the gated surface, not a bypass of it.
  "Bash(vidi-act *)",
].join(",");

/**
 * Hard no-list. `//` = absolute path, `~/` = home, `**` = glob — all three
 * forms verified to deny. Covers Read/Edit/Write; the honest gap: an
 * allowlisted interpreter (npm/npx scripts, bun, git show) could still touch
 * these — that layer is persona + journal, not mechanical. Raw node/python3
 * were removed from the allowlist (Tier-2 B3), shrinking that gap.
 */
export const SECRET_PATHS = [
  // `//` = absolute-path glob for the CLI deny-list, so prefix a leading slash
  // onto the already-absolute workspace path (→ "//<root>/keys.rtf").
  `/${workspacePath("keys.rtf")}`,
  "~/.ssh/**",
  "**/.proxy-secret",
  "**/.dev.vars",
  "**/.env*",
  "**/data/ntfy-topic",
  // The Hands API token — the shim reads it from disk itself; the agent must
  // never Read/Edit/Write it directly (that would let her forge a raw :4184
  // call and skip the vidi-act chokepoint).
  "**/data/hands-token",
  // The confirm queue's on-disk record. The agent files actions through
  // /api/confirm/request and confirms them by voice; direct edits would let her
  // forge or tamper with a pending action.
  "**/data/pending-action.json",
  // Phase 4a — extend the credential-read denylist. This is the primary
  // non-owner-facing fix: Plan mode still allows un-jailed Read, so every live
  // token/keychain on the machine must be on the deny-list, not just ~/.ssh.
  // Cloud CLI credentials.
  "~/.aws/**",
  "~/.config/gcloud/**",
  "**/.claude/.credentials.json",
  // Alternate claude account profiles — each carries its own credentials.json.
  "~/.claude-profiles/**",
  // codex (OpenAI CLI) auth lives here — .codex/auth.json is a live token.
  "~/.codex/**",
  // grok (xAI CLI) auth lives here — .grok/auth.json is a live session token,
  // and sessions/ transcripts + logs/ can carry secrets. Deny the whole tree so
  // no other provider's Read/Bash lane can lift the grok subscription token.
  "~/.grok/**",
  // macOS keychains (login.keychain-db etc.) — the master credential store.
  "~/Library/Keychains/**",
  // Per-install phone/control bearer tokens: the shim reads them itself; the
  // agent must never read them directly (that would let her forge a raw call
  // and skip the vidi-act / control chokepoints).
  "**/data/phone-token",
  "**/data/control-token",
  // Multi-account claude registry — holds config-dir paths + account ids.
  "**/data/accounts.json",
  // Phase 4a — F1 (privilege escalation). isOwner() (lib/user-config.ts)
  // infers ownership from these files: onboarded.json's `source` and the
  // presence of data/threads/*.json. Both live under WORKSPACE_ROOT, so an
  // AGENT-facing Write/Edit (Auto mode) OR a forged write-file confirm could
  // create/overwrite them and flip a non-owner to owner — unlocking egress,
  // wide read scope, and the Auto default. Deny both signals to the agent-
  // facing tools + the confirm executor (this list feeds both claude.ts's
  // Read/Edit/Write denylist AND lib/write-file-jail.ts's matchesSecretPath).
  // Server-side app code (saveThread, markOnboarded, writeEditableConfig) uses
  // direct fs and is unaffected. The durable owner marker is VIDI_OWNER=1 in
  // the owner's launchd plist; this denylist protects the file-inference fallback.
  "**/data/onboarded.json",
  "**/data/user-config.json",
  // The in-app Builder opt-in (act-mode self-escalation would be one Write
  // away otherwise — the guarded /api/builder-mode route is the ONLY writer).
  "**/data/builder-mode.json",
  // The Browser Rails opt-in (same class as builder-mode: turning on the
  // browser trust surface must not be one agent Write away — the guarded
  // /api/browser-rails route is the ONLY writer). Phase 1, default OFF.
  "**/data/browser-rails.json",
  // Stage 5: the customer's Discord webhook URL is a capability (anyone holding
  // it can post to their channel). Deny the agent's Read/Edit/Write so it can
  // neither exfiltrate it nor redirect the customer's notifications. The
  // trailing `*` also catches the transient `discord-webhook.json.tmp`
  // (lib/discord-notify.ts writes temp-then-rename), which briefly carries the
  // same secret before the atomic rename.
  "**/data/discord-webhook.json*",
  "**/data/threads/**",
  // P8 finding 4 (P7 re-audit) — the browser/phone bearer tokens the P7 lenses
  // found still readable through the Bash/Read lane. Reading data/session-token
  // hands a tailnet peer the browser read/config surface; the phone-browser
  // pairing cookie + one-time pairing code (lib/phone-browser-pairing.ts) each
  // grant the paired-phone surface. The shim/route code reads these itself; the
  // agent must never Read/Edit/Write them directly.
  "**/data/session-token",
  "**/data/phone-browser-cookie",
  "**/data/phone-pairing-code",
  // The pasted per-install premium-voice code (an A2 keyset key). The TTS route
  // reads it itself to send as x-vidi-key; the agent must never Read/Edit/Write
  // it directly (that would let her forge a raw vidi-proxy call on the
  // customer's metered key). Same treatment as the phone/control tokens.
  "**/data/voice-key",
];
/**
 * Branch→PR discipline, enforced mechanically (the owner's standing rule
 * 2026-07-05): never push directly to master/main — work lands on a feature
 * branch and arrives via PR. Deny beats a broader allow (`Bash(git *)`,
 * `Bash(gh *)`): verified headless on 2.1.x with an allow `Bash(ls *)` +
 * deny `Bash(ls -la*)` probe. Prefix rules, so `main*` also catches
 * `main --tags` etc. (and would false-positive a branch literally named
 * `main-…` — don't name branches that). The honest gap, same as
 * SECRET_PATHS: an allowlisted interpreter could still shell out; that
 * layer is persona + the addendum below, not mechanical.
 */
const GIT_PUSH_PROTECTED = [
  "Bash(git push)", // bare push = current branch; on master that's a direct push. Force the explicit form.
  "Bash(git push origin main*)",
  "Bash(git push origin master*)",
  "Bash(git push -u origin main*)",
  "Bash(git push -u origin master*)",
  "Bash(git push -f*)",
  "Bash(git push --force*)",
  "Bash(git push origin HEAD:main*)",
  "Bash(git push origin HEAD:master*)",
  // gh guardrails: token echo leaks the OAuth token to the transcript;
  // repo delete / secret are outward-destructive beyond any chat task.
  "Bash(gh auth token*)",
  "Bash(gh repo delete*)",
  "Bash(gh secret*)",
  // Merging is the owner's call — the pipeline is fable's final verdict →
  // Discord "APPROVE PR n" → inbox poller merges. Vidi opens PRs, never
  // lands them. gh api is denied whole: it is a raw REST escape hatch that
  // can merge, delete, and read secrets around the verb-level denies above.
  "Bash(gh pr merge*)",
  "Bash(gh api*)",
];
export const ACT_DISALLOWED_TOOLS = [
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  ...GIT_PUSH_PROTECTED,
  ...SECRET_PATHS.flatMap((p) => [`Read(${p})`, `Edit(${p})`, `Write(${p})`]),
].join(",");

/**
 * P3 belt (threat-model B5). The SECRET_PATHS deny as Read-tool rules. Act mode
 * already inlines these (ACT_DISALLOWED_TOOLS above); PLAN mode did NOT — its
 * disallow set (CHAT_DISALLOWED_TOOLS) blocks Bash/Write/Edit but left Read
 * un-jailed, so a plan-mode `Read(~/.codex/auth.json)` still read a live token.
 * Un-jailed Read is the primary non-owner (Plan-default) exfil surface,
 * so every credential glob must be denied to Read in plan mode too. Exported so
 * the belt is assertable in a test without a spawn.
 */
export const SECRET_READ_DENIES = SECRET_PATHS.map((p) => `Read(${p})`).join(",");

// The Bash-lane secret-read hook (P3). Absolute so the spawned CLI child (whose
// cwd is WORKSPACE_ROOT, not this repo) resolves it regardless of cwd.
const DENY_SECRET_READ_HOOK = path.join(REPO_ROOT, "hooks", "deny-secret-read.ts");

/** Single-quote a string for safe inclusion in the shell command the CLI runs
 *  the hook with (paths rarely contain spaces, but quote defensively). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Act-mode PreToolUse(Bash) hook settings (P3 / threat-model B5). Passed to the
 * CLI child via `--settings` (a JSON string, which the CLI loads ADDITIVELY on
 * top of `--setting-sources project`). Before every Bash tool call the CLI runs
 * hooks/deny-secret-read.ts, which denies + journals any command that reads a
 * SECRET_PATHS-protected file — closing the credential-exfil lane the
 * Read/Edit/Write denylist can't see (`Bash(cat ~/.codex/auth.json)`).
 *
 * The hook journals via the SAME data/ dir as the server; the child runs with
 * cwd=WORKSPACE_ROOT, so we pin VIDI_DATA_DIR onto the child env at spawn (below)
 * and the hook inherits it — otherwise its journal would land under the wrong
 * data/ dir. Exported so the wiring is unit-testable without a spawn.
 */
export function actModePreToolUseSettings(): {
  hooks: {
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<{ type: "command"; command: string }>;
    }>;
  };
} {
  const command = `${shellQuote(process.execPath)} ${shellQuote(DENY_SECRET_READ_HOOK)}`;
  return {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command }] },
      ],
    },
  };
}

// Browser hands (auto mode only): the official Playwright MCP server, run
// from this repo's node_modules against the installed Chrome. --isolated =
// in-memory profile, so concurrent fleet agents don't fight over a profile
// lock (tradeoff: no persisted logins). Headed on purpose — the owner watches.
const PLAYWRIGHT_MCP_CONFIG = path.join(process.cwd(), "mcp-playwright.json");

export const ACT_SYSTEM_ADDENDUM =
  "Auto mode is ON for this thread. Follow the 'Act mode' section of your persona: " +
  "state destructive/outward actions and wait for an explicit yes before doing them, " +
  "never touch secrets even via bash, and work in small verifiable steps. " +
  "You have BROWSER HANDS: the playwright MCP tools drive a real, visible " +
  "Chrome — navigate, read pages, click, fill forms, take screenshots. Use " +
  "them whenever a task needs the live web. Browsing/reading is fine " +
  "without asking; anything that submits, purchases, posts, signs in, or " +
  "otherwise acts AS the owner on a site needs their explicit yes first. The " +
  "profile is throwaway (no saved logins). " +
  // Tooling boundary: real-world verbs beat browser hands. The throwaway Chrome
  // is logged OUT, so the browser can never create a calendar event / send mail /
  // set a reminder — chasing it there just burns turn loops (the 2026-07-07
  // 14-turn calendar burn). Route those through their vidi-act verb, which files
  // a pending confirm; browser hands are only for things with no verb.
  "TOOLING: calendar and email actions MUST go through " +
  "their `vidi-act` verb (calendar-create, email-send) — " +
  "it files a pending confirmation for the owner. Do NOT try to do these in the " +
  "browser: the throwaway Chrome is logged out, so that path can only fail and " +
  "waste turns. Browser hands are for reading the live web and for actions that " +
  "have no vidi-act verb. " +
  // ARG SCHEMAS — the model was never told the JSON key names, so it guessed
  // ("recipient"/"message"/"title"/"text") and shipped broken actions past the
  // confirm (audit finding 1). Spell them out. Use LOCAL RFC3339 datetimes with
  // seconds ('2026-07-10T17:00:00') for calendar times.
  "vidi-act ARG SCHEMAS (use these exact keys): " +
  "email-send {to (must contain '@'), subject, body, cc?, bcc?}; " +
  "calendar-create {summary, start, end} (start/end = local datetime " +
  "'YYYY-MM-DDTHH:MM:SS', not date-only); " +
  "write-file {path, content}. " +
  "Sending a text message is NOT available yet — there is no working message " +
  "verb, so do not offer to text anyone or attempt it. " +
  // Headless truth: nobody is watching a permission dialog. Denied = denied.
  "You run headless — there is NO permission prompt and NO human to click " +
  "Allow. A denied tool call is a hard no from the sandbox, not a request " +
  "for review: do not wait, do not ask for approval, adapt. Your Bash is a " +
  "prefix allowlist (git, gh, npm, npx, bun, ls, mkdir, mv, " +
  "cp, touch, cat, head, tail, wc, pwd, which, gbrain read commands); raw " +
  "`node`/`python3` are NOT allowed — for anything else use Write/Edit for " +
  "files, or run it through an npm/npx script. " +
  "GIT WORKFLOW (standing rule): never commit on or push to master/main — " +
  "the sandbox denies direct pushes there. For any code change: create a " +
  "feature branch, commit on it, push it with `git push -u origin <branch>`, " +
  "then open a PR with `gh pr create`. Merging is the owner's call. " +
  "Build the thing with what you have and report what you actually did.";

const PLAN_SYSTEM_ADDENDUM =
  "Plan mode is ON for this thread: research with your read-only tools and " +
  "deliver your best thinking — a plan, an analysis, an answer. Do not " +
  "attempt to edit files or run commands in this mode.";

/**
 * Persona + mode addendum + per-call extra text, passed as one documented
 * `--append-system-prompt` flag (replaces the undocumented
 * `--append-system-prompt-file` we used before).
 */
/**
 * Token-discipline guidance for the ONLY turns that can spawn in-CLI Task
 * subagents: a deep/ultracode (opus) turn re-enables Task (see the ultracode
 * branch in sendMessage). There is NO CLI flag or env var that pins a spawned
 * Task subagent's model from here — the claude CLI controls that only via the
 * invoking agent's own frontmatter `model:` or an unused `--agents` json, so
 * this is enforced at the PERSONA level (a prompt instruction), not
 * mechanically. It mirrors Vidi's own model discipline: keep routine sub-work on
 * the cheap tier, reserve the top model for genuinely build-shaped sub-tasks.
 */
const SUBAGENT_MODEL_BRIEF =
  "Model discipline for any Task subagents you spawn: keep mechanical or routine " +
  "sub-work on the cheap tier (a Sonnet-class subagent) and reserve the top model " +
  "for genuinely build-shaped or deep sub-tasks — the same tiering Vidi applies to " +
  "her own fleet. Don't fan out top-tier subagents for shallow work.";

export function buildSystemPrompt(mode: "plan" | "auto", extra?: string): string {
  // Standing rules (lib/user-rules.ts) prepend the system prompt for
  // EVERY provider — same block in codex.ts and grok.ts — so they apply
  // regardless of which model this turn runs on.
  const rules = userRulesBlock();
  let sys = rules ? `${rules}\n\n` : "";
  try {
    sys += readFileSync(personaFile(), "utf8");
  } catch {
    /* persona file missing — proceed without it */
  }
  sys += `\n\n${mode === "auto" ? ACT_SYSTEM_ADDENDUM : PLAN_SYSTEM_ADDENDUM}`;
  if (extra) sys += `\n\n${extra}`;
  return sys;
}

/** Brief journal-friendly summary of a tool_use input. */
function summarizeToolInput(input: unknown): string {
  const i = input as Record<string, unknown> | null | undefined;
  if (!i || typeof i !== "object") return "";
  if (typeof i.command === "string") return i.command.slice(0, 200); // Bash
  if (typeof i.file_path === "string") return i.file_path; // Read/Write/Edit
  if (typeof i.pattern === "string") {
    return `${i.pattern}${typeof i.path === "string" ? ` in ${i.path}` : ""}`; // Grep/Glob
  }
  // Orchestration tools (Workflow/Task/Agent) carry big structured inputs —
  // raw JSON in the activity line read as garbage on the customer demo
  // (2026-07-12). Prefer the human fields, in order.
  for (const key of ["description", "name", "prompt", "query", "title"]) {
    const v = i[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim().replace(/\s+/g, " ").slice(0, 120);
    }
  }
  // Nested meta (Workflow scripts embed { meta: { name, description } }).
  const meta = i.meta as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const v = meta.description ?? meta.name;
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  try {
    return JSON.stringify(i).replace(/\\n/g, " ").replace(/\s+/g, " ").slice(0, 110);
  } catch {
    return "";
  }
}

/** brainRoot() with a fail-open guard: a bad config must never break a turn.
 *  Returns null on any error so dedupeExistingDirs drops it. */
function safeBrainRoot(): string | null {
  try {
    return brainRoot();
  } catch {
    return null;
  }
}

/**
 * The plan-mode `--add-dir` read scope (Phase 4a — H3). Owner: the whole home
 * (unchanged). Non-owner: only the dirs their writes are jailed to —
 * workspace + brain + Desktop + Downloads — so their Plan-mode read scope
 * matches their write scope and can't walk the rest of $HOME. Exported +
 * pure (existence-checked) so the scope is unit-testable without a spawn.
 */
export function planModeAddDirs(owner: boolean): string[] {
  return owner
    ? [HOME_DIR]
    : dedupeExistingDirs([WORK_DIR, safeBrainRoot(), DESKTOP_DIR, DOWNLOADS_DIR]);
}

/** Collapse a list of candidate --add-dir paths: drop null/blank, drop any dir
 *  that doesn't exist on disk (the CLI rejects a missing --add-dir), and dedupe.
 *  Used for the non-owner plan-mode read scope so a missing Desktop/Downloads/
 *  brain dir can't fail the spawn. */
function dedupeExistingDirs(candidates: Array<string | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) out.push(candidate);
  }
  // Never hand the CLI an empty --add-dir set: WORK_DIR (the cwd) is always the
  // spawn's working dir, so falling back to it keeps the workspace readable.
  return out.length > 0 ? out : [WORK_DIR];
}

function claudeBin(): string {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) {
    return process.env.CLAUDE_BIN;
  }
  const known = getUserConfig().claudeBin;
  return existsSync(known) ? known : "claude";
}

export const claudeProvider: BrainProvider = {
  id: "claude",
  label: "Claude Max",
  models: [
    { id: "auto", label: "Auto (Vidi routes)", default: true },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
  ],

  async available() {
    const bin = claudeBin();
    if (bin === "claude") {
      // Not at the known path; trust PATH but flag if clearly absent.
      return { ok: true };
    }
    return existsSync(bin)
      ? { ok: true }
      : {
          ok: false,
          reason:
            "Your AI account isn't connected yet. Open Setup to install and sign in, then try again.",
        };
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
    // P5 (owner-gated act mode). A non-owner reaches Auto/act mode ONLY
    // when the OWNER has explicitly opted them in (VIDI_ACT_OPT_IN) — never via
    // their own in-app Plan/Auto toggle. Absent that opt-in an "auto" request is
    // clamped to Plan, keeping the whole act-mode surface (Bash, Edit/Write,
    // browser hands) off their path. The owner is always allowed (actModeAllowed).
    const mode = actModeAllowed() ? normalizeMode(args.mode) : "plan";
    // The router turns model="auto" (+mode/effort) into a concrete model,
    // a real --effort value, an opus fallback for fable runs, and the
    // ultracode escape hatch when fable is down (see lib/models.ts).
    const run = resolveRun({ model: args.model, mode, effort: args.effort });
    const model = run.model;
    // `ultracode` is the CLI's opt-in keyword for multi-agent Workflow
    // orchestration — prepended to the prompt so opus genuinely fans out
    // when it wears the deep-planning hat. Threads store the clean message.
    const prompt = run.ultracode
      ? `ultracode\n\n${args.userMessage}`
      : args.userMessage;
    // Second-opinion MCP server (ask_gpt / ask_grok). Generated fresh each turn
    // as a project MCP config passed via --mcp-config below; loaded in BOTH
    // plan and act modes because the two tools are read-only consultations. The
    // config carries no key — the server reads it from disk itself. Best-effort:
    // a write failure just drops the tools for this turn, never breaks the spawn.
    let secondOpinionsMcpPath: string | null = null;
    try {
      secondOpinionsMcpPath = writeSecondOpinionsMcpConfig();
    } catch {
      secondOpinionsMcpPath = null;
    }
    const secondOpinionAllow = secondOpinionsMcpPath
      ? "," + SECOND_OPINION_ALLOWED_TOOLS
      : "";
    const cliArgs = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--append-system-prompt",
      // On an ultracode (deep/opus) turn Task is re-enabled, so append the
      // subagent model-discipline brief (persona-level — no CLI flag pins a
      // subagent's model from here; see SUBAGENT_MODEL_BRIEF).
      buildSystemPrompt(
        mode,
        run.ultracode
          ? `${args.extraSystemText ? `${args.extraSystemText}\n\n` : ""}${SUBAGENT_MODEL_BRIEF}`
          : args.extraSystemText
      ),
      // Only OUR mcp config loads (user settings allow some mutating servers);
      // both modes get the second-opinions server (added just below via
      // --mcp-config); auto mode also adds the playwright browser server.
      "--strict-mcp-config",
      "--model",
      model,
      "--effort",
      run.cliEffort,
    ];
    if (run.fallbackModel) {
      cliArgs.push("--fallback-model", run.fallbackModel);
    }
    // Load the second-opinions MCP config in both modes (--strict-mcp-config
    // above means only our --mcp-config sources load; act adds playwright too).
    if (secondOpinionsMcpPath) {
      cliArgs.push("--mcp-config", secondOpinionsMcpPath);
    }
    // Workflow/Task power the ultracode fan-out; subagents inherit this
    // run's permission rules, so the jail below still binds them.
    const extraTools = run.ultracode ? ",Task,Workflow" : "";
    if (mode === "auto") {
      cliArgs.push(
        // Drop ~/.claude/settings.json (blanket allows) — see header comment.
        "--setting-sources",
        "project",
        // Browser hands: playwright MCP server (visible Chrome). The bare
        // server name in allowedTools admits all of its tools.
        "--mcp-config",
        PLAYWRIGHT_MCP_CONFIG,
        // P3 (B5): the Bash-lane secret-read PreToolUse hook. `--settings` loads
        // additively alongside `--setting-sources project`, so this layers the
        // hook on top of the project settings without replacing
        // them.
        "--settings",
        JSON.stringify(actModePreToolUseSettings()),
        "--allowedTools",
        ACT_ALLOWED_TOOLS + ",mcp__playwright" + extraTools + secondOpinionAllow,
        "--disallowedTools",
        ACT_DISALLOWED_TOOLS,
        // Jails Edit/Write (not Read) to the workspace root (the workspace root; a
        // legacy symlink from an earlier repo layout still resolves into it)
        // plus the two user drop dirs.
        // ~/Desktop and ~/Downloads are the "just write it" zone: writes there
        // are direct (no confirm). A write ANYWHERE ELSE outside these must go
        // through vidi-act write-file → confirm queue.
        "--add-dir",
        WORK_DIR,
        "--add-dir",
        DESKTOP_DIR,
        "--add-dir",
        DOWNLOADS_DIR
      );
    } else {
      cliArgs.push(
        // Real plan mode, not a prompt rule: the CLI's own permission layer
        // blocks mutations for the whole turn.
        "--permission-mode",
        "plan",
        "--allowedTools",
        CHAT_ALLOWED_TOOLS + extraTools + secondOpinionAllow,
        // P3 belt (B5): append the SECRET_PATHS Read denies. Plan mode blocks
        // mutations wholesale, but left Read un-jailed — so deny reads of every
        // credential glob here too, closing the plan-mode `Read(secret)` surface.
        "--disallowedTools",
        (run.ultracode
          ? CHAT_DISALLOWED_TOOLS.replace(",Task", "")
          : CHAT_DISALLOWED_TOOLS) +
          "," +
          SECRET_READ_DENIES
      );
      // Plan-mode read scope (Phase 4a — H3). The OWNER keeps the whole home
      // readable (`--add-dir HOME_DIR`) — their read reach is unchanged. A
      // NON-owner install has plan-mode reads restricted to the same dirs
      // their writes are jailed to — workspace + brain + Desktop + Downloads —
      // so their read scope matches their write scope and a Plan-mode turn
      // can't walk the rest of $HOME. (The SECRET_PATHS denylist still binds
      // on top of whichever set is added.)
      for (const dir of planModeAddDirs(isOwner())) {
        cliArgs.push("--add-dir", dir);
      }
    }

    // One spawn of the CLI. Set outcome.retryWithoutResume instead of yielding
    // a terminal event when the stored session id turns out to be stale (the
    // CLI keys sessions by project cwd slug, so a workspace rename orphans
    // them — 2026-07-05 incident); the driver below then reruns once fresh.
    // outcome.limitError signals a usage/Fable-limit failure so the outer
    // account-rotation driver can fail over to another logged-in account
    // instead of surfacing the error.
    const outcome = { retryWithoutResume: false, limitError: false, loginError: false, networkError: false };
    // At most ONE automatic silent retry for a transient network-class error,
    // across the whole turn (not per-account). Declared here so runAttempt's
    // classifier can see whether the retry was already spent.
    let networkRetried = false;
    const runAttempt = async function* (
      resumeSessionId: string | null,
      configDir: string | null,
      modelOverride?: string
    ): AsyncGenerator<ProviderStreamEvent> {
      outcome.retryWithoutResume = false;
      outcome.limitError = false;
      outcome.loginError = false;
      outcome.networkError = false;
      const attemptArgs = [...cliArgs];
      if (modelOverride) {
        // Replace the resolved --model value (used by the final opus-downgrade
        // retry when every account has hit its fable limit).
        const mi = attemptArgs.indexOf("--model");
        if (mi >= 0) attemptArgs[mi + 1] = modelOverride;
      }
      if (resumeSessionId) {
        attemptArgs.push("--resume", resumeSessionId);
      }

      // A non-null account configDir reroutes the CLI to a different logged-in
      // account; null = today's behavior (inherit the process's default dir).
      // Tier-2 (S-env): a scrubbed, allowlisted env — NOT the full process.env —
      // so no proxy key / cloud credential / topic secret reaches the CLI child.
      const childEnv = scrubbedChildEnv(args.childEnv ?? {});
      if (configDir) childEnv.CLAUDE_CONFIG_DIR = configDir;
      // P3: the child runs with cwd=WORKSPACE_ROOT, but the PreToolUse secret-read
      // hook must journal to the SAME data/ dir the server uses. Pin the resolved
      // absolute data dir so the hook (which inherits this env) writes there.
      childEnv.VIDI_DATA_DIR = dataDir();

      // Pre-write the claude folder-trust marker for the exact config dir this
      // attempt will run under, so a fresh install never lands the spawned CLI
      // in a first-run "Do you trust this folder?" gate (Orca preset pattern).
      // Best-effort: a trust-write failure must never break a turn. Bounded to
      // WORK_DIR (the workspace root) by the module's assertTrustable guard.
      try {
        markClaudeWorkspaceTrusted(WORK_DIR, configDir ?? undefined);
      } catch {
        /* trust pre-write is advisory — never fail a turn over it */
      }

      const child = spawn(claudeBin(), attemptArgs, {
        cwd: WORK_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });

      // Kill-switch registry — engageKill() SIGKILLs everything registered.
      const unregister = child.pid
        ? registerRun(
            {
              pid: child.pid,
              threadId: args.threadId,
              provider: "claude",
              startedAt: Date.now(),
            },
            child
          )
        : () => {};

      // Model actually running this attempt (opus on the final downgrade retry).
      const effectiveModel = modelOverride || model;

      let stderrTail = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });

      let sessionId: string | null = resumeSessionId;
      const seenToolUseIds = new Set<string>();
      // Honest reasoning signal (never redacted text): presence of a thinking
      // content_block + the numeric thinking_tokens from the per-message
      // message_delta usage (the final result event drops it). See
      // ./reasoning-signal for the parse.
      let reasoning: ReasoningSignal = { reasoned: false };
      let accumulated = "";
      let resultText: string | null = null;
      let resultIsError = false;
      let resultSubtype: string | null = null;
      let resultErrorMessage = "";
      let usage: RunUsage | undefined;

      const rl = readline.createInterface({ input: child.stdout });

      // Merge line events and process-exit into one async queue.
      const queue: ProviderStreamEvent[] = [];
      let notify: (() => void) | null = null;
      let finished = false;
      let exitCode: number | null = null;

      const push = (ev: ProviderStreamEvent) => {
        queue.push(ev);
        notify?.();
      };

      // Auto mode and deep (fable/ultracode) turns get a longer leash: a
      // healthy Bash call or a workflow fan-out can run minutes with zero
      // stdout from the CLI in between.
      const inactivityMs =
        mode === "auto" || effectiveModel === "fable" || run.ultracode
          ? 300_000
          : INACTIVITY_MS;
      let lastActivity = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > inactivityMs) {
          child.kill("SIGKILL");
          push({
            type: "error",
            message: `claude CLI produced no output for ${Math.round(inactivityMs / 60_000)} minutes — killed.`,
          });
          finished = true;
          notify?.();
        }
      }, 5_000);

      // Abort (the explicit stop button, lib/turn-abort.ts): kill the child
      // and end the generator with a normal `done` carrying whatever text had
      // streamed so far, flagged `stopped` — a stop is not a failure, and the
      // partial answer must not be silently dropped. The turn resumes
      // cleanly later via --resume if the user asks again, so nothing durable
      // is lost either way.
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        push({ type: "done", providerSessionId: sessionId, fullText: accumulated, usage, stopped: true });
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

      rl.on("line", (line) => {
        lastActivity = Date.now();
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return; // skip CLI warnings on stdout
        let evt: any;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (evt.type === "system" && evt.subtype === "init" && evt.session_id) {
          sessionId = evt.session_id;
        } else if (evt.type === "assistant") {
          // Full assistant messages carry tool_use blocks with complete input.
          const content = evt.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type !== "tool_use" || typeof block.name !== "string") {
                continue;
              }
              // The same message can be re-emitted; dedupe on tool_use id.
              if (typeof block.id === "string") {
                if (seenToolUseIds.has(block.id)) continue;
                seenToolUseIds.add(block.id);
              }
              push({
                type: "tool",
                tool: block.name,
                summary: summarizeToolInput(block.input),
              });
            }
          }
        } else if (evt.type === "stream_event") {
          const inner = evt.event;
          if (
            inner?.type === "content_block_delta" &&
            inner.delta?.type === "text_delta" &&
            typeof inner.delta.text === "string"
          ) {
            accumulated += inner.delta.text;
            push({ type: "delta", text: inner.delta.text });
          } else {
            // Honest reasoning signal (thinking-block presence + thinking_tokens).
            reasoning = foldReasoningSignal(reasoning, evt);
          }
        } else if (evt.type === "result") {
          if (evt.session_id) sessionId = evt.session_id;
          // Availability learning: a fable-requested turn reports which models
          // actually ran; falling back to opus flips the router's cache.
          if (effectiveModel === "fable" && evt.modelUsage && typeof evt.modelUsage === "object") {
            recordFableObservation(Object.keys(evt.modelUsage));
          }
          if (evt.is_error) {
            resultIsError = true;
            resultSubtype = typeof evt.subtype === "string" ? evt.subtype : null;
            resultErrorMessage =
              typeof evt.result === "string" ? evt.result : evt.subtype || "unknown error";
          } else if (typeof evt.result === "string") {
            resultText = evt.result;
          }
          // Quota ledger source: the CLI reports usage + API-equivalent cost.
          const u = evt.usage;
          usage = {
            inputTokens: typeof u?.input_tokens === "number" ? u.input_tokens : undefined,
            outputTokens: typeof u?.output_tokens === "number" ? u.output_tokens : undefined,
            cacheReadTokens:
              typeof u?.cache_read_input_tokens === "number"
                ? u.cache_read_input_tokens
                : undefined,
            cacheCreationTokens:
              typeof u?.cache_creation_input_tokens === "number"
                ? u.cache_creation_input_tokens
                : undefined,
            costUsd:
              typeof evt.total_cost_usd === "number" ? evt.total_cost_usd : undefined,
            durationMs:
              typeof evt.duration_ms === "number" ? evt.duration_ms : undefined,
            numTurns: typeof evt.num_turns === "number" ? evt.num_turns : undefined,
          };
        }
      });

      child.on("close", (code) => {
        exitCode = code;
        finished = true;
        clearInterval(watchdog);
        notify?.();
      });
      child.on("error", (err) => {
        push({ type: "error", message: `failed to spawn claude CLI: ${err.message}` });
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
            provider: "claude",
            threadId: args.threadId,
            model: effectiveModel,
            mode,
            ...usage,
          });
        }

        // onAbort already yielded its own done (with the partial text) and set
        // finished — exitCode is still null this tick (the child's 'close'
        // hasn't landed yet), which would otherwise misclassify a clean stop
        // as "terminated by signal" and yield a second, contradicting error.
        if (aborted) return;

        // exitCode null after close = died to a signal (kill switch, external
        // kill) without a result — that is an error, not a silent partial done.
        if (resultIsError || exitCode !== 0) {
          const detail =
            resultErrorMessage ||
            stderrTail.trim() ||
            (exitCode === null ? "terminated by signal" : `exit code ${exitCode}`);
          // Every CLI failure lands in the server log WITH the stderr tail —
          // during the 2026-07-05 stale-session incident stderrTail was
          // captured but never logged, and the empty log cost diagnosis time.
          console.error(
            `[claude] CLI error (thread=${args.threadId}, model=${effectiveModel}, exit=${exitCode}, resume=${resumeSessionId ?? "none"}): ${detail}` +
              (stderrTail.trim() ? ` | stderr: ${stderrTail.trim()}` : "")
          );
          const emittedOutput = accumulated.length > 0 || seenToolUseIds.size > 0;
          // Usage/Fable-limit error with nothing streamed yet → the outer
          // account-rotation driver retries the SAME turn on another account.
          // (After output was emitted, retrying would duplicate it — same
          // guard the stale-session retry uses.)
          if (isLimitError(detail) && !emittedOutput) {
            outcome.limitError = true;
            return;
          }
          // Not-logged-in / dead-credentials account: same recovery shape as
          // a limit (another account can take the turn), but the driver must
          // skip this account without ever persisting it as active.
          if (isLoginError(detail) && !emittedOutput) {
            outcome.loginError = true;
            return;
          }
          // Transient network-class failure (no internet / VPN / proxy / DNS /
          // reset). Recovers by simply trying again: when nothing has streamed
          // yet AND the one retry is unspent, hand the driver a networkError
          // signal (no terminal event) so it re-runs once silently. Otherwise
          // (output already streamed, or the retry was already used) surface the
          // friendly, persona-voiced line here — never the raw CLI connection
          // string (that stays in the server log above).
          if (isNetworkError(detail)) {
            if (shouldRetryNetwork({ errorDetail: detail, emittedOutput, alreadyRetried: networkRetried })) {
              outcome.networkError = true;
              return;
            }
            yield { type: "error", message: FRIENDLY_NETWORK_MESSAGE, usage };
            return;
          }
          if (
            shouldRetryWithoutResume({
              resumeUsed: resumeSessionId !== null,
              emittedOutput,
              errorSubtype: resultSubtype,
              errorDetail: detail,
            })
          ) {
            // No terminal event: the driver reruns once without --resume.
            outcome.retryWithoutResume = true;
            return;
          }
          yield { type: "error", message: `claude CLI error: ${detail.slice(0, 500)}`, usage };
          return;
        }

        // Once-per-turn, only when the turn actually reasoned. Emitted just
        // before done so the UI can attach the badge to the finished message.
        if (reasoning.reasoned) {
          yield { type: "reasoning", reasoned: true, tokens: reasoning.tokens };
        }

        yield {
          type: "done",
          providerSessionId: sessionId,
          // || not ??: the CLI can report result:"" on tool-heavy turns — an
          // empty final summary must not erase the text that actually streamed.
          fullText: resultText || accumulated,
          usage,
        };
      } finally {
        clearInterval(watchdog);
        args.signal?.removeEventListener("abort", onAbort);
        if (exitCode === null) child.kill("SIGKILL");
        unregister();
      }
    };

    // Pump one attempt's events out to the caller while (a) mirroring every
    // streamed delta into the live buffer so a reconnecting client can replay
    // the in-flight text, and (b) making the failover switch notice DURABLE:
    // it's prepended to the first delta AND folded into the persisted
    // done.fullText, so the "⚠ … switched to …" line survives in the thread
    // transcript (before this it was stream-only — gone on reload). Returns
    // whether this attempt produced a done event.
    async function* pump(
      attempt: AsyncGenerator<ProviderStreamEvent>,
      notice: string | null,
      accountId: string
    ): AsyncGenerator<ProviderStreamEvent, boolean> {
      let noticeEmitted = false;
      let sawDone = false;
      for await (const ev of attempt) {
        if (ev.type === "delta") {
          const text = notice && !noticeEmitted ? ((noticeEmitted = true), notice + ev.text) : ev.text;
          appendLive(args.threadId, text);
          yield { type: "delta", text };
          continue;
        }
        if (ev.type === "done") {
          sawDone = true;
          if (notice && !noticeEmitted) {
            // No delta carried the notice (empty/tool-only reply) — still show it.
            noticeEmitted = true;
            appendLive(args.threadId, notice);
            yield { type: "delta", text: notice };
          }
          // Fold the notice into the persisted message so it survives reload.
          const fullText = notice ? notice + ev.fullText : ev.fullText;
          yield { ...ev, fullText, accountId };
          continue;
        }
        yield ev;
      }
      return sawDone;
    }

    // Account rotation + resume driver. Registry order is the failover order.
    // We start on the thread's active account and, on a limit error, retry the
    // same turn on each remaining account; if every account hits a fable
    // limit, one final retry downgrades the model to opus (fable-only limits
    // don't apply there). Each new account forces a fresh session — a stored
    // CLI session belongs to the config dir that created it.
    const registry = enabledAccounts();
    const activeAccount = getActiveAccount();
    // Order: active account first, then the rest in registry order.
    const order: Account[] = [
      activeAccount,
      ...registry.filter((a) => a.id !== activeAccount.id),
    ];

    // The live buffer mirrors this turn's streamed text for reconnect replay;
    // clear it once the turn ends (done, error, or the consumer breaking the
    // generator via return()) — the final text is persisted to the thread by
    // then, so the transient mirror has done its job.
    try {

    // Resume only when the SAME account created the stored session. A foreign
    // session (explicit different owner) must not be --resume'd on this
    // account. A legacy session with UNKNOWN owner (no sessionAccountId — from
    // before multi-account) is treated as belonging to the active account, so
    // existing threads keep resuming after the upgrade; the done event then
    // stamps the owner for future turns.
    const priorSessionId = args.priorProviderSessionId ?? null;
    const sessionOwner = args.sessionAccountId ?? null;

    const tried = new Set<string>();
    // Why the previous account failed — drives the visible switch notice and
    // the journal summary. kind "login" = skipped a dead account.
    let prevFailure: { label: string; kind: "limit" | "login" } | null = null;
    // Last account that failed on a LIMIT (logged in, just capped) — the only
    // sane target for the final opus downgrade. A login-dead account can't
    // run opus either (2026-07-05 alt-profile incident).
    let lastLimitAccount: Account | null = null;
    const loginDeadLabels: string[] = [];

    for (let i = 0; i < order.length; i++) {
      const account = order[i];
      tried.add(account.id);
      const configDir = expandConfigDir(account.configDir);
      // Resume only on the first attempt AND only if this account owns the
      // stored session (or the owner is unknown = legacy, treated as the
      // active account, which IS order[0]); every failover attempt starts
      // fresh (no --resume — the session belongs to another config dir).
      const ownsSession = sessionOwner === null || sessionOwner === account.id;
      const resume = i === 0 && ownsSession ? priorSessionId : null;

      // A one-line notice prepended to the first delta of a successful reply,
      // so the switch is visible in the chat bubble.
      const notice = prevFailure
        ? prevFailure.kind === "limit"
          ? `⚠ ${prevFailure.label} hit its usage limit — switched to ${account.label}.\n\n`
          : `⚠ ${prevFailure.label} is not logged in — switched to ${account.label}.\n\n`
        : null;
      let sawDone = yield* pump(runAttempt(resume, configDir), notice, account.id);

      // Stale stored session → one no-resume retry on the SAME account.
      // retryWithoutResume is only set on an error BEFORE any output, so the
      // first pump never emitted the notice — carry it onto the retry so the
      // switch line still shows. The stale id is dropped on a repeat error.
      if (outcome.retryWithoutResume) {
        console.error(
          `[claude] stored session ${resume} not found (thread=${args.threadId}, account=${account.id}) — retrying once without --resume`
        );
        for await (const ev of pump(runAttempt(null, configDir), notice, account.id)) {
          if (ev.type === "done") sawDone = true;
          // Stale id must be dropped even when the fresh run also fails.
          yield ev.type === "error" ? { ...ev, resetProviderSession: true } : ev;
        }
      }

      // Transient network-class failure with NOTHING streamed → ONE silent
      // retry on the SAME account/session (runAttempt only raises networkError
      // before any output, so this never double-applies a partial turn). Spend
      // the retry, then re-run: if it also fails, runAttempt's classifier sees
      // networkRetried=true and yields the friendly line itself; if it succeeds,
      // we fall through to the success path below.
      if (outcome.networkError) {
        networkRetried = true;
        console.error(
          `[claude] transient network error (thread=${args.threadId}, account=${account.id}) — one silent retry`
        );
        sawDone = yield* pump(runAttempt(resume, configDir), notice, account.id);
      }

      if (!outcome.limitError && !outcome.loginError) {
        // Success, or a non-recoverable error already surfaced by runAttempt.
        // Persist the winner ONLY on real success — persisting after an error
        // left the dead alt profile active (2026-07-05 incident).
        if (sawDone && account.id !== activeAccount.id) {
          setActiveAccountId(account.id);
          appendJournal({
            ts: Date.now(),
            threadId: args.threadId,
            tool: "account-switch",
            summary: `${activeAccount.label} → ${account.label} (${
              prevFailure?.kind === "login" ? "not logged in" : "usage limit"
            })`,
          });
        }
        return;
      }

      // Recoverable failure: remember why for the next account's notice.
      if (outcome.limitError) {
        lastLimitAccount = account;
        prevFailure = { label: account.label, kind: "limit" };
        console.error(
          `[claude] account ${account.id} hit a usage limit (thread=${args.threadId}) — failing over`
        );
      } else {
        loginDeadLabels.push(account.label);
        prevFailure = { label: account.label, kind: "login" };
        console.error(
          `[claude] account ${account.id} is not logged in (thread=${args.threadId}) — skipping`
        );
      }
    }

    // Every account failed. If this was a fable-tier turn and at least one
    // account is actually logged in (it failed on a LIMIT), do ONE final
    // retry there with the model downgraded to opus (fable-only limits don't
    // gate opus). Never target a login-dead account — opus fails there too.
    if (model === "fable" && lastLimitAccount) {
      const target = lastLimitAccount;
      const configDir = expandConfigDir(target.configDir);
      const notice = `⚠ every usable account hit its Fable limit — retrying on ${target.label} with Opus.\n\n`;
      for await (const ev of pump(runAttempt(null, configDir, "opus"), notice, target.id)) {
        if (ev.type === "done") {
          if (target.id !== activeAccount.id) setActiveAccountId(target.id);
          appendJournal({
            ts: Date.now(),
            threadId: args.threadId,
            tool: "account-switch",
            summary: `all usable accounts hit Fable limit → ${target.label} on Opus`,
          });
        }
        yield ev;
      }
      if (!outcome.limitError && !outcome.loginError) return;
    }

    // Nothing worked — say exactly why, per failure class.
    const loginNote =
      loginDeadLabels.length > 0
        ? ` (${loginDeadLabels.join(", ")}: not logged in — run /login under that profile's CLAUDE_CONFIG_DIR)`
        : "";
    yield {
      type: "error",
      message: lastLimitAccount
        ? `claude CLI error: every configured account has reached its usage limit${loginNote}. Run /usage-credits or wait for the limit to reset.`
        : `claude CLI error: no configured account is logged in${loginNote}.`,
    };
    } finally {
      clearLive(args.threadId);
    }
  },
};
