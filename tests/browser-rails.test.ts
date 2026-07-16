import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  normalizeDomain,
  buildAllowlist,
  hostAllowed,
  checkUrl,
} from "../lib/browser-rails/allowlist.ts";
import {
  BrowserSession,
  BROWSER_TOOL_NAMES,
  availableBrowserTools,
} from "../lib/browser-rails/tools.ts";
import {
  browserRailsEnabled,
  setBrowserRails,
  BROWSER_TASK_BUDGET,
} from "../lib/browser-rails/config.ts";
import { browserRailsCliWiring } from "../lib/browser-rails/registration.ts";
import {
  type BrowserDriver,
  BrowserUnavailableError,
} from "../lib/browser-rails/driver.ts";
import { SECRET_PATHS } from "../lib/providers/claude.ts";

/**
 * Browser Rails — Phase 1 (default OFF). Tests cover: flag gating (tools absent
 * / refused when OFF), allowlist enforcement, budget caps, and the
 * graceful-degrade path when Playwright is absent. No test loads Playwright or
 * launches a real browser — the driver is mocked behind its interface.
 */

// ---- fixtures ----------------------------------------------------------------

const created: string[] = [];
function freshDataDir(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-browserrails-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  process.env.VIDI_DATA_DIR = path.join(dir, "data");
  created.push(dir);
}

test.afterEach(() => {
  delete process.env.VIDI_DATA_DIR;
  delete process.env.VIDI_BROWSER_RAILS;
});

test.after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

/** A mock driver that records calls and can be pointed at any landing URL (to
 *  simulate a click that navigates off-list). Never touches Playwright. */
function mockDriver(opts: { landOn?: string } = {}) {
  const calls: string[] = [];
  let url = "https://example.com/";
  const driver: BrowserDriver = {
    async open(u) {
      calls.push("open:" + u);
      url = u;
      return { url, title: "Example" };
    },
    async read() {
      calls.push("read");
      return { url, title: "Example", text: "hello page text" };
    },
    async screenshot() {
      calls.push("screenshot");
      return { base64: "AAAA" };
    },
    async click(sel) {
      calls.push("click:" + sel);
      if (opts.landOn) url = opts.landOn;
      return { url };
    },
    currentUrl() {
      return url;
    },
    async close() {
      calls.push("close");
    },
  };
  return { driver, calls, makeDriver: async () => driver };
}

// ---- allowlist ---------------------------------------------------------------

test("normalizeDomain reduces scheme/path/port/wildcard to a bare host", () => {
  assert.equal(normalizeDomain("https://www.Example.com/path?q=1"), "www.example.com");
  assert.equal(normalizeDomain("*.example.com"), "example.com");
  assert.equal(normalizeDomain("example.com:8080/x"), "example.com");
  assert.equal(normalizeDomain("localhost"), "localhost");
  assert.equal(normalizeDomain("   "), null);
  assert.equal(normalizeDomain("not a domain"), null);
});

test("hostAllowed matches exact + subdomain but not lookalike", () => {
  const list = buildAllowlist(["example.com", "*.wikipedia.org"]);
  assert.ok(hostAllowed("example.com", list));
  assert.ok(hostAllowed("en.wikipedia.org", list));
  assert.ok(!hostAllowed("evil-example.com", list));
  assert.ok(!hostAllowed("example.com.attacker.net", list));
});

test("checkUrl refuses non-http schemes and off-list hosts", () => {
  const list = buildAllowlist(["example.com"]);
  assert.ok(checkUrl("https://example.com/ok", list).ok);
  assert.equal(checkUrl("file:///etc/passwd", list).ok, false);
  assert.equal(checkUrl("javascript:alert(1)", list).ok, false);
  assert.equal(checkUrl("https://attacker.net/", list).ok, false);
});

// ---- flag gating -------------------------------------------------------------

test("flag defaults OFF; no tools advertised when OFF", () => {
  freshDataDir();
  assert.equal(browserRailsEnabled(), false);
  assert.deepEqual(availableBrowserTools(), []);
  assert.equal(browserRailsCliWiring().enabled, false);
  assert.equal(browserRailsCliWiring().allowedToolsFragment, "");
});

test("flag ON advertises all five tools and the CLI wiring", () => {
  freshDataDir();
  setBrowserRails(true);
  assert.equal(browserRailsEnabled(), true);
  assert.deepEqual([...availableBrowserTools()], [...BROWSER_TOOL_NAMES]);
  const wiring = browserRailsCliWiring();
  assert.equal(wiring.enabled, true);
  assert.match(wiring.allowedToolsFragment, /mcp__browser_rails/);
  assert.equal(wiring.toolNames.length, 5);
});

test("session refuses every action while the flag is OFF (defense in depth)", async () => {
  freshDataDir(); // OFF
  const { makeDriver, calls } = mockDriver();
  const s = new BrowserSession(["example.com"], makeDriver);
  const r = await s.open("https://example.com/");
  assert.equal(r.ok, false);
  assert.match(r.message, /turned off/i);
  assert.deepEqual(calls, []); // driver never constructed
});

// ---- allowlist enforcement in a live session ---------------------------------

test("open is allowed for on-list hosts, refused for off-list", async () => {
  freshDataDir();
  setBrowserRails(true);
  const { makeDriver, calls } = mockDriver();
  const s = new BrowserSession(["example.com"], makeDriver);

  const ok = await s.open("https://example.com/page");
  assert.equal(ok.ok, true);

  const bad = await s.open("https://attacker.net/");
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not on the approved list/i);
  assert.ok(!calls.includes("open:https://attacker.net/"));
});

test("a click that navigates off-list is a hard stop and closes the browser", async () => {
  freshDataDir();
  setBrowserRails(true);
  const { makeDriver, calls } = mockDriver({ landOn: "https://attacker.net/next" });
  const s = new BrowserSession(["example.com"], makeDriver);
  await s.open("https://example.com/");
  const r = await s.click("a.link");
  assert.equal(r.ok, false);
  assert.match(r.message, /not approved/i);
  assert.ok(calls.includes("close"));
});

// ---- budget ------------------------------------------------------------------

test("page budget caps the number of navigations per task", async () => {
  freshDataDir();
  setBrowserRails(true);
  const { makeDriver } = mockDriver();
  const s = new BrowserSession(["example.com"], makeDriver);
  for (let i = 0; i < BROWSER_TASK_BUDGET.maxPages; i++) {
    const r = await s.open("https://example.com/" + i);
    assert.equal(r.ok, true);
  }
  const over = await s.open("https://example.com/over");
  assert.equal(over.ok, false);
  assert.match(over.message, /limit/i);
});

// ---- graceful degrade --------------------------------------------------------

test("missing Playwright degrades to a plain-language message, not a throw", async () => {
  freshDataDir();
  setBrowserRails(true);
  const makeDriver = async (): Promise<BrowserDriver> => {
    throw new BrowserUnavailableError("Browser tools are not installed yet.");
  };
  const s = new BrowserSession(["example.com"], makeDriver);
  const r = await s.open("https://example.com/");
  assert.equal(r.ok, false);
  assert.match(r.message, /not installed/i);
});

// ---- state file is protected -------------------------------------------------

test("browser-rails state file is on the SECRET_PATHS agent denylist", () => {
  assert.ok(
    SECRET_PATHS.some((p) => p.includes("browser-rails.json")),
    "the opt-in file must be denied to Read/Edit/Write so the agent can't self-enable"
  );
});
