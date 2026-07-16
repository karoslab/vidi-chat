import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Stage-4 JourneyStep contract: verify() returns the {ok:true,note?} /
 * {ok:false,reason,fixStepId?} shape, makes a REAL API round-trip (so a revoked
 * credential fails), and points a failure back at the device-code step.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-ghstep-"));
const FAKE_GH = path.join(tmp, "gh");
fs.writeFileSync(
  FAKE_GH,
  `#!/bin/sh
sub="$1 $2"
case "$sub" in
  "auth status")
    if [ "$FAKE_GH_CONNECTED" = "1" ]; then
      echo "  Logged in to github.com account testuser (keyring)"; exit 0
    fi
    echo "You are not logged into any GitHub hosts." 1>&2; exit 1 ;;
  "api user")
    if [ "$FAKE_GH_CONNECTED" = "1" ]; then echo "testuser"; exit 0; fi
    echo "HTTP 401" 1>&2; exit 1 ;;
  *) exit 3 ;;
esac
`,
  { mode: 0o755 }
);
process.env.GH_BIN = FAKE_GH;

const { githubStep, GITHUB_CONNECT_STEP_ID } = await import("../lib/journey/steps/github.ts");

test("step metadata: stage 4, plain title, stable id", () => {
  assert.equal(githubStep.stage, 4);
  assert.equal(githubStep.title, "Your GitHub");
  assert.equal(githubStep.id, GITHUB_CONNECT_STEP_ID);
});

test("verify() ok when connected and the API call succeeds", async () => {
  process.env.FAKE_GH_CONNECTED = "1";
  const r = await githubStep.verify();
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.note || "", /testuser/);
});

test("verify() reports the plain-language not-installed reason when gh is missing", async () => {
  const prevBin = process.env.GH_BIN;
  process.env.GH_BIN = path.join(tmp, "gh-does-not-exist");
  const r = await githubStep.verify();
  process.env.GH_BIN = prevBin;
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.fixStepId, GITHUB_CONNECT_STEP_ID);
    assert.match(r.reason, /installer should have added it/i);
    assert.doesNotMatch(r.reason, /[—–]/); // no em/en dashes in customer copy
  }
});

test("verify() fails back to the device-code step when not connected", async () => {
  delete process.env.FAKE_GH_CONNECTED;
  const r = await githubStep.verify();
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.fixStepId, GITHUB_CONNECT_STEP_ID);
    assert.equal(typeof r.reason, "string");
    assert.doesNotMatch(r.reason, /[—–]/); // no em/en dashes in customer copy
  }
});

/**
 * MECHANICAL no-dash guard (2026-07-11 HOLD finding — five customer-facing em
 * dashes shipped despite the copy rule, because each prior test only checked
 * ONE sentence at a time). Instead of adding another narrow per-string
 * assertion every time new copy lands, this scans every file Stage 4 owns for
 * em/en dashes OUTSIDE comments — catching a dash in a NEW string, route, or
 * JSX screen automatically, with no test to remember to add.
 *
 * Comment-stripping is intentionally simple (line // and block /* *\/) — good
 * enough for this codebase's style and matches what a plain-text `grep -v`
 * review would show; it does not attempt full JS/TSX parsing.
 */
test("Stage 4 owned files carry no em/en dashes outside comments", () => {
  const root = new URL("../", import.meta.url);
  const OWNED_FILES = [
    "lib/github-connect.ts",
    "lib/secret-scan.ts",
    "lib/journey/steps/github.ts",
    "app/api/github/start-connect/route.ts",
    "app/api/github/status/route.ts",
    "app/api/github/backup-now/route.ts",
    "components/journey/steps/GithubStep.tsx",
  ];
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  for (const rel of OWNED_FILES) {
    const src = fs.readFileSync(new URL(rel, root), "utf8");
    const code = stripComments(src);
    const hit = /[—–]/.exec(code);
    const context = hit ? code.slice(Math.max(0, hit.index - 40), hit.index + 40) : "";
    assert.equal(hit, null, `${rel} has an em/en dash outside a comment near: ${context}`);
  }
});
