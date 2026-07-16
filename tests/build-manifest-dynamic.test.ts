import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression lock for the 2026-07-06 false-positive incident: a production
 * verification pass reported every requireReadAuth()-gated route (and the root
 * layout) as prerendered/cached in the deployed build (`x-nextjs-prerender: 1`,
 * `x-nextjs-cache: HIT`, `s-maxage=31536000`, a bogus session token returning
 * 200). Root cause turned out to be a live `next start` process left running
 * against a `.next`/NEXT_DIST_DIR output directory that got deleted and
 * rebuilt out from under it (stale manifest file descriptors), NOT a caching-
 * model defect in `dynamic = "force-dynamic"` — confirmed by two independent
 * clean builds + fresh `next start` runs, all correctly dynamic (see PR body
 * for the full curl evidence). This test is the honest, build-output-level
 * assertion that node --test CAN make (it invokes handlers directly and can't
 * observe a real server's HTTP cache headers, which is exactly what let the
 * false root-cause theory look plausible from unit tests alone):
 *
 *   `.next/prerender-manifest.json`'s `routes` + `dynamicRoutes` maps must
 *   NEVER contain any of our routes — only Next's own internal
 *   `/_global-error` may appear there. If a future change (a stray
 *   `generateStaticParams`, a `cacheComponents` flag, a removed `dynamic`
 *   export) causes Next to prerender one of these routes, this manifest WILL
 *   list it, and this test WILL fail.
 *
 * This performs one real `next build` into an isolated NEXT_DIST_DIR (cleaned
 * up after) — the only way to get an honest build-artifact assertion, not a
 * mock. It is the slow test in the suite by design (a real Next build).
 */

const DIST_DIR = ".next-test-manifest-check";
const DIST_PATH = path.join(process.cwd(), DIST_DIR);

const GATED_ROUTES = [
  "/",
  "/api/accounts",
  "/api/agents",
  "/api/agents/events",
  "/api/agents/names",
  "/api/attachments",
  "/api/context/vision",
  "/api/goals",
  "/api/journal",
  "/api/kill",
  "/api/onboarding",
  "/api/onboarding/backends",
  "/api/onboarding/deferred",
  "/api/onboarding/intro",
  "/api/overlay",
  "/api/providers",
  "/api/quota",
  "/api/swarm",
  "/api/threads",
  "/api/threads/search",
  "/api/usage/retro",
  "/api/user-config",
];

let manifest: { routes: Record<string, unknown>; dynamicRoutes: Record<string, unknown> };

// Next auto-appends this run's NEXT_DIST_DIR into tsconfig.json's `include`
// array on every build (so the generated .next/types get typechecked) and
// never removes stale entries — a real build run here would otherwise leave a
// permanent, accumulating diff on tsconfig.json. Snapshot it and restore
// verbatim in `after`, so this test is self-contained and idempotent.
const TSCONFIG_PATH = path.join(process.cwd(), "tsconfig.json");
let tsconfigSnapshot: string | null = null;

before(() => {
  tsconfigSnapshot = fs.readFileSync(TSCONFIG_PATH, "utf8");
  fs.rmSync(DIST_PATH, { recursive: true, force: true });
  execFileSync("npm", ["run", "build"], {
    cwd: process.cwd(),
    env: { ...process.env, NEXT_DIST_DIR: DIST_DIR },
    stdio: "pipe", // keep test output clean; surfaced on failure via the thrown error
    timeout: 180_000,
  });
  const raw = fs.readFileSync(path.join(DIST_PATH, "prerender-manifest.json"), "utf8");
  manifest = JSON.parse(raw);
});

after(() => {
  fs.rmSync(DIST_PATH, { recursive: true, force: true });
  if (tsconfigSnapshot !== null) fs.writeFileSync(TSCONFIG_PATH, tsconfigSnapshot);
});

test("prerender-manifest.json exists and has the expected shape", () => {
  assert.ok(manifest, "build must produce prerender-manifest.json");
  assert.equal(typeof manifest.routes, "object");
  assert.equal(typeof manifest.dynamicRoutes, "object");
});

test("no gated route is statically prerendered", () => {
  const staticallyPrerendered = new Set([
    ...Object.keys(manifest.routes),
    ...Object.keys(manifest.dynamicRoutes),
  ]);
  for (const route of GATED_ROUTES) {
    assert.ok(
      !staticallyPrerendered.has(route),
      `${route} must NOT appear in prerender-manifest.json (it would mean Next ` +
        `served a cached/static response instead of running requireReadAuth on ` +
        `every request)`
    );
  }
});

test("only Next's own internal routes may be prerendered", () => {
  // Next's own internal routes, plus the app-router icon/manifest file
  // conventions (app/icon.svg, app/apple-icon.png, app/manifest.ts). Those are
  // public, static, auth-free assets — being prerendered/cached is correct for
  // them and carries no session-token surface, so they are safe to allow here.
  const allowed = new Set([
    "/_global-error",
    "/_not-found",
    "/icon.svg",
    "/apple-icon.png",
    "/manifest.webmanifest",
  ]);
  for (const route of Object.keys(manifest.routes)) {
    assert.ok(
      allowed.has(route),
      `unexpected prerendered route "${route}" — if this is one of ours, the ` +
        `Tier-2 gate would silently no-op in production`
    );
  }
});
