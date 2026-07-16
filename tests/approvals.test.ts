import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Stage 5 — the approval desk. Everything here isolates: a temp workspace root
 * (so repo discovery scans fake dirs, not the real machine) and injected gh /
 * git / journal / spool / ping so no real network, merge, or file write happens.
 */

// A temp cwd so any accidental default data write can't touch the live data dir,
// and a temp workspace root so discoverProjectRepos scans fake project dirs.
const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-approvals-cwd-"));
process.chdir(testCwd);
const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-approvals-ws-"));
process.env.VIDI_WORKSPACE_ROOT = wsRoot;

// Two fake project repos (each with a .git marker) + one non-repo dir.
for (const name of ["repoA", "repoB"]) {
  fs.mkdirSync(path.join(wsRoot, name, ".git"), { recursive: true });
}
fs.mkdirSync(path.join(wsRoot, "notarepo"), { recursive: true });

const {
  parseOwnerRepo,
  parsePrRef,
  summarizeCard,
  discoverProjectRepos,
  listPendingWork,
  approve,
  requestChanges,
} = await import("../lib/approvals.ts");

/* ------------------------------ pure helpers ----------------------------- */

test("parseOwnerRepo handles https and ssh remotes, strips .git", () => {
  assert.equal(parseOwnerRepo("https://github.com/karoslab/vidi-chat.git"), "karoslab/vidi-chat");
  assert.equal(parseOwnerRepo("https://github.com/karoslab/vidi-chat"), "karoslab/vidi-chat");
  assert.equal(parseOwnerRepo("git@github.com:karoslab/vidi-chat.git"), "karoslab/vidi-chat");
  assert.equal(parseOwnerRepo("ssh://git@github.com/karoslab/demo-app.git\n"), "karoslab/demo-app");
  assert.equal(parseOwnerRepo("https://gitlab.com/x/y.git"), null);
  assert.equal(parseOwnerRepo("not a url"), null);
});

test("parsePrRef parses owner/repo#n and rejects junk", () => {
  assert.deepEqual(parsePrRef("karoslab/vidi-chat#12"), { repo: "karoslab/vidi-chat", number: 12 });
  assert.equal(parsePrRef("karoslab/vidi-chat"), null);
  assert.equal(parsePrRef("karoslab/vidi-chat#0"), null);
  assert.equal(parsePrRef("karoslab/vidi-chat#-1"), null);
  assert.equal(parsePrRef("#5"), null);
});

test("summarizeCard: only additions → nothing existing changed; customer words, no dashes", () => {
  const a = summarizeCard({ title: "x", additions: 120, deletions: 0, changedFiles: 4 });
  assert.equal(a.nothingExistingChanged, true);
  assert.match(a.summary, /nothing you already had was changed/);
  assert.doesNotMatch(a.summary, /[–—]/); // no en/em dashes

  const b = summarizeCard({ title: "x", additions: 30, deletions: 8, changedFiles: 2 });
  assert.equal(b.nothingExistingChanged, false);
  assert.match(b.summary, /adds 30 lines and updates 8 lines/);

  const c = summarizeCard({ title: "x", additions: 0, deletions: 0, changedFiles: 0 });
  assert.equal(c.nothingExistingChanged, false);
  assert.match(c.summary, /no line changes/i);

  // Singular grammar.
  const d = summarizeCard({ title: "x", additions: 1, deletions: 0, changedFiles: 1 });
  assert.match(d.summary, /1 new line across 1 file/);
});

/* --------------------------- discovery + listing ------------------------- */

const fakeGit = async (_args: string[], cwd: string) =>
  `https://github.com/karoslab/${path.basename(cwd)}.git\n`;

test("discoverProjectRepos finds only the .git dirs, mapped to owner/repo", async () => {
  const repos = await discoverProjectRepos({ git: fakeGit });
  assert.deepEqual(repos, ["karoslab/repoA", "karoslab/repoB"]);
});

test("listPendingWork maps open PRs to plain-language cards (mock gh)", async () => {
  const fakeGh = async (args: string[]) => {
    const repo = args[args.indexOf("--repo") + 1];
    return JSON.stringify([
      {
        number: 7,
        title: `work in ${repo}`,
        body: "",
        url: `https://github.com/${repo}/pull/7`,
        headRefName: "feature/x",
        additions: 40,
        deletions: 0,
        changedFiles: 3,
      },
    ]);
  };
  const cards = await listPendingWork({ gh: fakeGh, git: fakeGit });
  assert.equal(cards.length, 2);
  const a = cards.find((c) => c.repo === "karoslab/repoA")!;
  assert.equal(a.ref, "karoslab/repoA#7");
  assert.equal(a.nothingExistingChanged, true);
  assert.match(a.summary, /adds 40 new lines across 3 files/);
  assert.equal(a.url, "https://github.com/karoslab/repoA/pull/7");
});

test("listPendingWork fails open when gh errors for a repo (skips it, no throw)", async () => {
  const throwingGh = async () => {
    throw new Error("gh: not authenticated");
  };
  const cards = await listPendingWork({ gh: throwingGh, git: fakeGit });
  assert.deepEqual(cards, []);
});

/* --------------------------------- approve ------------------------------- */

test("approve runs gh pr merge --squash, journals it, mirrors a ping", async () => {
  const calls: string[][] = [];
  const journalled: any[] = [];
  const pings: string[] = [];
  const res = await approve("karoslab/repoA#7", {
    gh: async (args) => {
      calls.push(args);
      return "";
    },
    journal: (e) => journalled.push(e),
    ping: async (t) => {
      pings.push(t);
      return {};
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], ["pr", "merge", "7", "--repo", "karoslab/repoA", "--squash"]);
  assert.equal(journalled.length, 1);
  assert.equal(journalled[0].tool, "Approve");
  assert.match(journalled[0].summary, /karoslab\/repoA#7/);
  assert.ok(pings.some((p) => /is now live/.test(p)));
});

test("approve surfaces a gh failure (e.g. squash disabled / branch protection) and does not journal", async () => {
  const journalled: any[] = [];
  const res = await approve("karoslab/repoA#7", {
    gh: async () => {
      throw new Error("Squash merging is not allowed on this repository");
    },
    journal: (e) => journalled.push(e),
    ping: async () => ({}),
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /Squash merging is not allowed/);
  assert.equal(journalled.length, 0);
});

test("approve rejects a malformed reference before any side effect", async () => {
  let called = false;
  const res = await approve("not-a-ref", {
    gh: async () => {
      called = true;
      return "";
    },
  });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

/* ----------------------------- request changes --------------------------- */

test("requestChanges comments on the PR and seeds a follow-up for Vidi", async () => {
  const calls: string[][] = [];
  const spooled: any[] = [];
  const journalled: any[] = [];
  const res = await requestChanges("karoslab/repoB#3", "Please make the button bigger", {
    gh: async (args) => {
      calls.push(args);
      return "";
    },
    spool: (e) => spooled.push(e),
    journal: (e) => journalled.push(e),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], [
    "pr",
    "comment",
    "3",
    "--repo",
    "karoslab/repoB",
    "--body",
    "Please make the button bigger",
  ]);
  assert.equal(spooled.length, 1);
  assert.equal(spooled[0].kind, "approvals.changes_requested");
  assert.equal(spooled[0].detail, "Please make the button bigger");
  assert.equal(journalled.length, 1);
  assert.equal(journalled[0].tool, "RequestChanges");
});

test("requestChanges rejects an empty note before any side effect", async () => {
  let called = false;
  const res = await requestChanges("karoslab/repoB#3", "   ", {
    gh: async () => {
      called = true;
      return "";
    },
    spool: () => {},
    journal: () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

/* --------------- regression: agent CLI sessions cannot merge ------------- */

test("REGRESSION: an act-mode agent CLI session still cannot merge or use gh api", async () => {
  // The customer's server route merges (the designed chokepoint). The agent's
  // own CLI lane must stay denied — this is what keeps GIT_PUSH_PROTECTED bound
  // to agent sessions only. Assert the deny still ships in the act toolset.
  const { ACT_DISALLOWED_TOOLS } = await import("../lib/providers/claude.ts");
  assert.match(ACT_DISALLOWED_TOOLS, /Bash\(gh pr merge\*\)/);
  assert.match(ACT_DISALLOWED_TOOLS, /Bash\(gh api\*\)/);
});
