/**
 * Browser Rails — the driver seam (Phase 1).
 *
 * The tool layer (tools.ts) talks ONLY to this `BrowserDriver` interface, never
 * to Playwright directly. That gives us two things:
 *   1. Tests mock the driver, so `npm test` never needs Playwright or a real
 *      browser (CI stays light; the customer payload isn't dragged into CI).
 *   2. Playwright is loaded LAZILY and OPTIONALLY. If it isn't installed we
 *      degrade gracefully with a plain-language message instead of crashing —
 *      the browser component is only downloaded on first enable (see the design
 *      doc + consent copy for size).
 */

/** A single read result from a page. */
export interface PageText {
  url: string;
  title: string;
  /** Extracted, human-readable text / accessibility snapshot of the page. */
  text: string;
}

/** The minimal capability set the tools drive. Every method is async; a real
 *  implementation wraps one ephemeral Playwright context. */
export interface BrowserDriver {
  /** Navigate to an (already allowlist-checked) URL. */
  open(url: string): Promise<{ url: string; title: string }>;
  /** Read the current page as text / accessibility snapshot. */
  read(): Promise<PageText>;
  /** Screenshot the current page, returned as base64 PNG. */
  screenshot(): Promise<{ base64: string }>;
  /** Click an element by selector. */
  click(selector: string): Promise<{ url: string }>;
  /** The URL the driver is currently on (for post-click allowlist re-checks). */
  currentUrl(): string;
  /** Tear down the ephemeral browser + context. */
  close(): Promise<void>;
}

/** Raised when Playwright (or its browser binary) isn't available. The tool
 *  layer catches this and returns the plain-language degrade message. */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

export const BROWSER_NOT_INSTALLED_MESSAGE =
  "Browser tools are not installed yet. Turn on Browser Rails in Settings — the " +
  "first time you do, Vidi downloads a small browser component (about 150 MB). " +
  "Until then there is nothing to drive.";

/**
 * Attempt to build a REAL Playwright-backed driver with a FRESH EPHEMERAL
 * profile (no stored cookies, no logged-in session — the v1 rail). Playwright
 * is imported dynamically so a build/test without it never fails to resolve;
 * a missing module or missing browser binary throws BrowserUnavailableError,
 * which the caller renders as BROWSER_NOT_INSTALLED_MESSAGE.
 *
 * Phase 1 note: this is the real driver, but the wiring that exposes it to the
 * CLI as MCP tools is the Phase 2 job (see registration.ts / the design doc).
 * The driver + tool logic here are exercised end-to-end against a mock.
 */
export async function createPlaywrightDriver(): Promise<BrowserDriver> {
  let chromium: any;
  try {
    // Dynamic + string-built specifier so bundlers don't hard-require it.
    const mod: any = await import("playwright" + "");
    chromium = mod.chromium;
    if (!chromium) throw new Error("playwright.chromium missing");
  } catch (err) {
    throw new BrowserUnavailableError(
      BROWSER_NOT_INSTALLED_MESSAGE + ` (${(err as Error).message})`
    );
  }

  let browser: any;
  try {
    // headless + a throwaway context = fresh ephemeral profile. No
    // storageState, no userDataDir → nothing is logged in, ever.
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new BrowserUnavailableError(
      BROWSER_NOT_INSTALLED_MESSAGE + ` (${(err as Error).message})`
    );
  }

  const context = await browser.newContext({
    // Deny downloads at the context level (belt on top of the tool-layer rail).
    acceptDownloads: false,
  });
  const page = await context.newPage();

  return {
    async open(url: string) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return { url: page.url(), title: await page.title() };
    },
    async read() {
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      return { url: page.url(), title: await page.title(), text };
    },
    async screenshot() {
      const buf: Buffer = await page.screenshot({ type: "png" });
      return { base64: buf.toString("base64") };
    },
    async click(selector: string) {
      await page.click(selector, { timeout: 5000 });
      return { url: page.url() };
    },
    currentUrl() {
      return page.url();
    },
    async close() {
      await context.close();
      await browser.close();
    },
  };
}
