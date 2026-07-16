#!/usr/bin/env node
/**
 * snap.mjs — the loop's "eyes". Screenshots a URL to a PNG so an act-mode
 * agent can Read it and judge its own work (CNVS design loops). Dependency is
 * Playwright, but we use the SYSTEM Chrome channel first so no ~150MB browser
 * download is needed; falls back to a bundled chromium if present.
 *
 * Usage: node scripts/snap.mjs <url> <out.png> [--full] [--width 1440] [--height 900] [--wait 800]
 * On failure it prints a one-line reason to stderr and exits non-zero, so a
 * loop agent can degrade gracefully (keep working without a screenshot).
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
if (!url || !out) {
  process.stderr.write("usage: node scripts/snap.mjs <url> <out.png> [--full] [--width N] [--height N] [--wait ms]\n");
  process.exit(2);
}
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const full = args.includes("--full");
const width = parseInt(flag("width", "1440"), 10);
const height = parseInt(flag("height", "900"), 10);
const waitMs = parseInt(flag("wait", "800"), 10);

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  process.stderr.write("playwright not installed — run: npm i -D playwright\n");
  process.exit(3);
}

async function launch() {
  // Prefer the installed system Chrome (no download); fall back to bundled.
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    try {
      return await chromium.launch({ headless: true });
    } catch (e) {
      process.stderr.write(
        `no browser available — run: npx playwright install chromium (${e?.message || e})\n`
      );
      process.exit(3);
    }
  }
}

const browser = await launch();
try {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  await page.screenshot({ path: out, fullPage: full });
  process.stdout.write(`wrote ${out}\n`);
} catch (e) {
  process.stderr.write(`snap failed: ${e?.message || e}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
