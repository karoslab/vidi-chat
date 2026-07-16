/**
 * Browser Rails — the tool set (Phase 1).
 *
 * Five tools over the driver seam: browser_open, browser_read,
 * browser_screenshot, browser_click, browser_close. This module holds the RAILS
 * that sit between the model and the driver:
 *
 *   - flag gate: with Browser Rails OFF, the tools do not exist at all (the
 *     session's tool list is empty). This mirrors how auto-mode tools only
 *     appear in auto mode.
 *   - allowlist: every navigation and every post-click landing URL is checked
 *     against the task's approved domains; an off-list host is a hard stop.
 *   - budget: per-task page + wall-clock caps stop a runaway loop.
 *   - graceful degrade: if Playwright isn't installed, tools return the
 *     plain-language "not installed" message instead of throwing.
 *
 * The page text a browser_read returns is UNTRUSTED DATA. Callers that feed it
 * back into a model prompt MUST wrap it with the untrusted-content envelope
 * (lib/untrusted.ts) — page text is never an instruction. See THREAT_MODEL.
 */

import { browserRailsEnabled, BROWSER_TASK_BUDGET } from "./config.ts";
import { buildAllowlist, checkUrl } from "./allowlist.ts";
import {
  type BrowserDriver,
  BrowserUnavailableError,
  BROWSER_NOT_INSTALLED_MESSAGE,
  createPlaywrightDriver,
} from "./driver.ts";

/** The five Phase-1 tool names, in one place so the flag-gating test can assert
 *  presence/absence without stringly duplicating them. */
export const BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_read",
  "browser_screenshot",
  "browser_click",
  "browser_close",
] as const;

/**
 * The tool names available for a session, given the live flag. OFF → none. This
 * is the single source the CLI wiring reads to decide whether to advertise the
 * browser tools at all.
 */
export function availableBrowserTools(): readonly string[] {
  return browserRailsEnabled() ? BROWSER_TOOL_NAMES : [];
}

export interface ToolResult {
  ok: boolean;
  /** Human/agent-facing text (a refusal reason, page text, or a status line). */
  message: string;
  /** Structured payload on success (page title, base64 screenshot, url, ...). */
  data?: Record<string, unknown>;
}

/**
 * A live browsing session: one ephemeral browser, one approved allowlist, one
 * budget. Construct it with the domains the user approved for THIS task. A
 * driver factory is injected so tests pass a mock and production passes the real
 * Playwright factory (default).
 */
export class BrowserSession {
  private readonly allowlist: string[];
  private driver: BrowserDriver | null = null;
  private pagesOpened = 0;
  private readonly startedAt = Date.now();
  private readonly makeDriver: () => Promise<BrowserDriver>;

  constructor(
    approvedDomains: readonly string[],
    makeDriver: () => Promise<BrowserDriver> = createPlaywrightDriver
  ) {
    this.allowlist = buildAllowlist(approvedDomains);
    this.makeDriver = makeDriver;
  }

  /** Budget check shared by the acting tools. */
  private budgetRefusal(forNavigation: boolean): ToolResult | null {
    if (Date.now() - this.startedAt > BROWSER_TASK_BUDGET.wallClockMs) {
      return {
        ok: false,
        message:
          "This browsing task has hit its time limit. Start a fresh task if you " +
          "still need to keep going.",
      };
    }
    if (forNavigation && this.pagesOpened >= BROWSER_TASK_BUDGET.maxPages) {
      return {
        ok: false,
        message:
          `This browsing task has opened its limit of ${BROWSER_TASK_BUDGET.maxPages} pages. ` +
          "Start a fresh task to open more.",
      };
    }
    return null;
  }

  /** Lazily bring up the driver, translating a missing Playwright into a plain
   *  degrade message rather than an exception. */
  private async ensureDriver(): Promise<{ driver?: BrowserDriver; degrade?: ToolResult }> {
    if (this.driver) return { driver: this.driver };
    try {
      this.driver = await this.makeDriver();
      return { driver: this.driver };
    } catch (err) {
      if (err instanceof BrowserUnavailableError) {
        return { degrade: { ok: false, message: err.message } };
      }
      throw err;
    }
  }

  /** Guard: refuse everything when the flag is OFF. Defense in depth — the CLI
   *  shouldn't advertise these tools at all when off, but a direct caller must
   *  still be refused. */
  private flagRefusal(): ToolResult | null {
    if (!browserRailsEnabled()) {
      return {
        ok: false,
        message:
          "Browser Rails is turned off. The user can turn it on in Settings; " +
          "it stays off until they do.",
      };
    }
    return null;
  }

  async open(url: string): Promise<ToolResult> {
    const off = this.flagRefusal();
    if (off) return off;
    const budget = this.budgetRefusal(true);
    if (budget) return budget;

    const check = checkUrl(url, this.allowlist);
    if (!check.ok) return { ok: false, message: check.reason! };

    const { driver, degrade } = await this.ensureDriver();
    if (degrade) return degrade;

    const res = await driver!.open(url);
    this.pagesOpened += 1;
    return { ok: true, message: `Opened ${res.title || res.url}`, data: res };
  }

  async read(): Promise<ToolResult> {
    const off = this.flagRefusal();
    if (off) return off;
    const budget = this.budgetRefusal(false);
    if (budget) return budget;
    const { driver, degrade } = await this.ensureDriver();
    if (degrade) return degrade;
    const page = await driver!.read();
    return { ok: true, message: page.text, data: { url: page.url, title: page.title } };
  }

  async screenshot(): Promise<ToolResult> {
    const off = this.flagRefusal();
    if (off) return off;
    const budget = this.budgetRefusal(false);
    if (budget) return budget;
    const { driver, degrade } = await this.ensureDriver();
    if (degrade) return degrade;
    const shot = await driver!.screenshot();
    return { ok: true, message: "Captured a screenshot of the current page.", data: shot };
  }

  async click(selector: string): Promise<ToolResult> {
    const off = this.flagRefusal();
    if (off) return off;
    const budget = this.budgetRefusal(false);
    if (budget) return budget;
    const { driver, degrade } = await this.ensureDriver();
    if (degrade) return degrade;

    const res = await driver!.click(selector);
    // A click can navigate. Re-check the landing URL against the allowlist; if it
    // wandered off-list, that's a hard stop and we close so the off-list page
    // can't be read or acted on.
    const check = checkUrl(res.url, this.allowlist);
    if (!check.ok) {
      await this.close();
      return {
        ok: false,
        message:
          `That click led to ${check.host ?? "an off-list page"}, which is not approved ` +
          `for this task. Stopped and closed the browser. ${check.reason ?? ""}`.trim(),
      };
    }
    return { ok: true, message: `Clicked ${selector}`, data: res };
  }

  async close(): Promise<ToolResult> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
    return { ok: true, message: "Closed the browser." };
  }
}

export { BROWSER_NOT_INSTALLED_MESSAGE };
