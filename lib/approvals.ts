import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT } from "./workspace.ts";
import { appendJournal, type JournalEntry } from "./journal.ts";
import { spoolEvent } from "./event-spool.ts";
import type { VidiEvent } from "./events-types.ts";
import { sendPing } from "./discord-notify.ts";

/**
 * Stage 5 — "Your approval desk".
 *
 * The IN-APP approval desk is the source of truth for merging Vidi's work. This
 * module lists the customer's pending work (open PRs across their own project
 * repos, discovered from the workspace's git remotes), maps each to a
 * plain-language card, and performs the two customer actions — approve (merge)
 * and ask-for-changes (comment + a follow-up seed for Vidi).
 *
 * SECURITY — the designed chokepoint: approve() runs `gh pr merge` and it is
 * meant to. This is the CUSTOMER clicking "make it live" on their OWN machine,
 * merging their OWN project. That is exactly the one place a merge is allowed.
 * It is NOT a hole in the agent guardrail: an ACT-mode agent CLI session still
 * cannot run `gh pr merge` — it is denied in lib/providers/claude.ts
 * (ACT_DISALLOWED_TOOLS / GIT_PUSH_PROTECTED). Keep it that way; the regression
 * test in tests/approvals.test.ts asserts that deny still holds. The customer's
 * server-route click and the agent's CLI lane are two different trust surfaces.
 */

/* --------------------------------- types --------------------------------- */

export interface PendingWorkCard {
  /** Canonical reference "owner/repo#123" — the id every action takes. */
  ref: string;
  /** "owner/repo". */
  repo: string;
  number: number;
  /** The raw PR title (data — may carry commit-convention prefixes). */
  title: string;
  /** Plain-language, customer-words summary generated from title + diff stats. */
  summary: string;
  /** True when nothing that already existed was changed (only additions). */
  nothingExistingChanged: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** The PR page — the "See it first" deep link (the full diff in the browser). */
  url: string;
  branch: string;
}

/** A raw PR as returned by `gh pr list --json ...`. */
interface RawPr {
  number: number;
  title: string;
  body?: string | null;
  url: string;
  headRefName?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

/** Injectable side effects so the desk logic is unit-testable without touching
 *  real gh / the events spool / the live journal. Defaults are the real ones. */
export interface ApprovalDeps {
  /** Runs `gh <args>` and resolves stdout. Rejects on non-zero exit. */
  gh?: GhRunner;
  /** Runs `git <args>` and resolves stdout. */
  git?: GitRunner;
  spool?: (partial: Omit<VidiEvent, "id" | "ts">) => void;
  journal?: (entry: JournalEntry) => void;
  ping?: (text: string) => Promise<unknown>;
}

export type GhRunner = (args: string[], cwd?: string) => Promise<string>;
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/* -------------------------------- runners -------------------------------- */

function bin(name: "gh" | "git"): string {
  return name === "gh" ? process.env.GH_BIN || "gh" : process.env.GIT_BIN || "git";
}

function runCli(name: "gh" | "git", args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin(name),
      args,
      { cwd, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        err ? reject(new Error(stderr?.toString().trim() || err.message)) : resolve(stdout)
    );
  });
}

const defaultGh: GhRunner = (args, cwd) => runCli("gh", args, cwd);
const defaultGit: GitRunner = (args, cwd) => runCli("git", args, cwd);

/* ------------------------------ pure helpers ----------------------------- */

/** Parse an origin remote URL (https or ssh form) to "owner/repo", else null. */
export function parseOwnerRepo(remoteUrl: string): string | null {
  const m = remoteUrl
    .trim()
    .match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const owner = m[1].trim();
  const repo = m[2].trim();
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/** Parse a card ref "owner/repo#123" into its parts, else null. */
export function parsePrRef(ref: string): { repo: string; number: number } | null {
  const m = ref.trim().match(/^([^\s#]+\/[^\s#]+)#(\d+)$/);
  if (!m) return null;
  const number = Number(m[2]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repo: m[1], number };
}

/**
 * Turn a PR into a plain-language, customer-words summary. Deterministic and
 * pure (no model call) — derived from the diff stats, which is exactly the
 * "what changed / nothing existing was changed" signal the desk needs, with no
 * per-card LLM latency. (A worker-tier model summary of the body is a possible
 * future enhancement; the router in lib/models.ts routes low-effort work to the
 * worker tier if that is ever wired in.)
 */
export function summarizeCard(pr: {
  title: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}): { summary: string; nothingExistingChanged: boolean } {
  const additions = Math.max(0, pr.additions ?? 0);
  const deletions = Math.max(0, pr.deletions ?? 0);
  const files = Math.max(0, pr.changedFiles ?? 0);
  const nothingExistingChanged = deletions === 0 && additions > 0;

  const fileWord = files === 1 ? "file" : "files";
  const addWord = additions === 1 ? "line" : "lines";
  const delWord = deletions === 1 ? "line" : "lines";

  let stats: string;
  if (additions === 0 && deletions === 0) {
    stats = "There are no line changes to look over.";
  } else if (nothingExistingChanged) {
    stats = `It adds ${additions} new ${addWord} across ${files} ${fileWord}, and nothing you already had was changed.`;
  } else if (additions === 0) {
    stats = `It removes ${deletions} ${delWord} across ${files} ${fileWord}.`;
  } else {
    stats = `It adds ${additions} ${addWord} and updates ${deletions} ${delWord} across ${files} ${fileWord}.`;
  }

  return { summary: stats, nothingExistingChanged };
}

function toCard(repo: string, pr: RawPr): PendingWorkCard {
  const { summary, nothingExistingChanged } = summarizeCard(pr);
  return {
    ref: `${repo}#${pr.number}`,
    repo,
    number: pr.number,
    title: pr.title,
    summary,
    nothingExistingChanged,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? 0,
    url: pr.url,
    branch: pr.headRefName ?? "",
  };
}

/* ---------------------------- repo discovery ----------------------------- */

/**
 * Discover the customer's project repos from the workspace's git remotes: every
 * sibling directory of vidi-chat that is a git repo with a GitHub origin. Fails
 * OPEN per-directory (a dir without .git / without an origin is skipped).
 */
export async function discoverProjectRepos(deps: ApprovalDeps = {}): Promise<string[]> {
  const git = deps.git ?? defaultGit;
  const found = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const dir = path.join(WORKSPACE_ROOT, entry.name);
      if (!fs.existsSync(path.join(dir, ".git"))) return;
      try {
        const out = await git(["remote", "get-url", "origin"], dir);
        const repo = parseOwnerRepo(out);
        if (repo) found.add(repo);
      } catch {
        /* no origin / not a github remote — skip */
      }
    })
  );
  return [...found].sort();
}

/* ------------------------------- listing --------------------------------- */

const PR_JSON_FIELDS = "number,title,body,url,headRefName,additions,deletions,changedFiles";

async function listOpenPrs(repo: string, gh: GhRunner): Promise<PendingWorkCard[]> {
  try {
    const out = await gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      PR_JSON_FIELDS,
      "--limit",
      "50",
    ]);
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((pr) => pr && typeof pr.number === "number")
      .map((pr: RawPr) => toCard(repo, pr));
  } catch {
    // No access / no such repo / gh not authed → fail open, skip this repo.
    return [];
  }
}

/**
 * The customer's pending work: every open PR across their discovered project
 * repos, mapped to a plain-language card. Newest (highest number) first within
 * a repo; repos in discovery order.
 */
export async function listPendingWork(deps: ApprovalDeps = {}): Promise<PendingWorkCard[]> {
  const gh = deps.gh ?? defaultGh;
  const repos = await discoverProjectRepos(deps);
  const perRepo = await Promise.all(repos.map((repo) => listOpenPrs(repo, gh)));
  const cards = perRepo.flat();
  cards.sort((a, b) => (a.repo === b.repo ? b.number - a.number : a.repo < b.repo ? -1 : 1));
  return cards;
}

/* -------------------------------- actions -------------------------------- */

export interface ActionResult {
  ok: boolean;
  ref: string;
  /** Plain-language outcome, safe to show the customer. */
  message: string;
}

/**
 * Approve = make it live. Runs `gh pr merge --squash` for the customer's own
 * repo (the designed chokepoint — see the module header). Journaled on success,
 * mirrors a "now live" ping to Discord (best-effort), and returns a
 * plain-language result. A bad ref is a 400-shaped {ok:false}; a gh failure
 * (branch protection, squash disabled, no access) surfaces gh's message.
 */
export async function approve(ref: string, deps: ApprovalDeps = {}): Promise<ActionResult> {
  const gh = deps.gh ?? defaultGh;
  const journal = deps.journal ?? appendJournal;
  const ping = deps.ping ?? sendPing;

  const parsed = parsePrRef(ref);
  if (!parsed) {
    return { ok: false, ref, message: "That work reference doesn't look right." };
  }
  try {
    await gh(["pr", "merge", String(parsed.number), "--repo", parsed.repo, "--squash"]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Best-effort mirror of a failure (item 4: "work failed").
    void Promise.resolve(ping(`Vidi's work ${ref} could not go live yet. ${reason}`)).catch(
      () => {}
    );
    return {
      ok: false,
      ref,
      message: `That couldn't go live yet. ${reason}`,
    };
  }

  journal({
    ts: Date.now(),
    threadId: "approvals",
    tool: "Approve",
    summary: `${ref} approved and merged (squash)`,
  });
  void Promise.resolve(ping(`Your OK went through. ${ref} is now live.`)).catch(() => {});

  return { ok: true, ref, message: "Done. It's live now." };
}

/**
 * Ask for changes = comment the note on the PR AND drop a follow-up seed into
 * the event spine so Vidi surfaces it as a task to pick up. Journaled. The note
 * is required (an empty note is rejected before any side effect).
 */
export async function requestChanges(
  ref: string,
  note: string,
  deps: ApprovalDeps = {}
): Promise<ActionResult> {
  const gh = deps.gh ?? defaultGh;
  const journal = deps.journal ?? appendJournal;
  const spool = deps.spool ?? spoolEvent;

  const parsed = parsePrRef(ref);
  if (!parsed) {
    return { ok: false, ref, message: "That work reference doesn't look right." };
  }
  const trimmed = note.trim();
  if (!trimmed) {
    return { ok: false, ref, message: "Tell Vidi what to change first." };
  }

  try {
    await gh(["pr", "comment", String(parsed.number), "--repo", parsed.repo, "--body", trimmed]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, ref, message: `Couldn't send that back. ${reason}` };
  }

  // Follow-up seed for Vidi (surfaces in her session preamble / brief-me).
  spool({
    source: "app",
    kind: "approvals.changes_requested",
    priority: "normal",
    title: `Changes asked for on ${ref}`,
    spoken: `You asked for changes on ${ref}. Want me to pick that up?`,
    detail: trimmed,
    ttlMinutes: 24 * 60,
    dedupeKey: `approvals-changes-${ref}`,
  });

  journal({
    ts: Date.now(),
    threadId: "approvals",
    tool: "RequestChanges",
    summary: `${ref}: asked for changes`,
  });

  return { ok: true, ref, message: "Sent back to Vidi with your note." };
}
