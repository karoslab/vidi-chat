# Browser Rails — browser automation for Vidi (Phase 1 design)

**Status:** Phase 1, foundation. Flag default **OFF**. Draft.
**Ask:** Vidi should be able to "open a browser and navigate through them
automatically." This is a multi-day track; this doc + the code that lands with
it are the rails-ed foundation, not the full vision.

## Capability model

Browser Rails lets the assistant drive a **headless Playwright browser** to open
pages, read them, click through them, and screenshot them, so it can carry out a
web task on the user's behalf. It is a **new trust surface** and is treated the
same way Builder mode was: its own explicit consent gate, off by default, with
plain-language copy about what it can and can never do.

- **Off until turned on.** The capability lives behind `data/browser-rails.json`
  (`browserRailsEnabled()`), default OFF, fail-closed. There is no env default
  that flips it on and no "owner gets it free". When OFF the browser tools are
  not advertised to the CLI at all.
- **Enabling = explicit consent** in Settings → Privacy, the same pattern as the
  Builder-mode confirm. The toggle copy states exactly what it can do, what it
  can never do, and that it downloads a browser component (~150 MB) on first use.
- **Driven via an MCP server vidi-chat manages, loopback-only.** The browser is
  never a public endpoint; it is a local subprocess the app owns. (Phase 1 ships
  the driver + tool rails; the stdio MCP server process is Phase 2 — see
  "Phase 1 vs Phase 2" below.)

## v1 rails (what is enforced)

1. **Fresh ephemeral browser profile ONLY.** Every task launches a throwaway
   Playwright context: no `storageState`, no `userDataDir`, nothing logged in.
   No user profiles, cookies, or logged-in sessions are used, **ever**, in v1.
2. **Per-task domain allowlist.** The agent must declare the domains a task
   needs; the user approves them. Every navigation and every post-click landing
   URL is checked against that list (exact host or subdomain, http/https only).
   An off-list host is a hard stop.
3. **No downloads.** `acceptDownloads:false` on the context, and the tool set
   exposes no download primitive.
4. **No form submission to non-allowlisted hosts.** Submissions route through
   the same URL chokepoint as navigation, so a form cannot POST to a host the
   user never approved.
5. **Read primitives are primary.** `browser_read` (page text / accessibility
   snapshot) and `browser_screenshot` are the main way the agent perceives a
   page; clicking is available but reading is the default posture.
6. **Per-task budget.** Max 20 navigations and a 5-minute wall-clock cap
   (`BROWSER_TASK_BUDGET`), after which the driver refuses further work.

## Tool set (Phase 1)

Five tools over a `BrowserDriver` interface (`lib/browser-rails/`):

| tool | what it does |
|---|---|
| `browser_open(url)` | navigate to an allowlist-checked URL |
| `browser_read()` | current page as text / accessibility snapshot (UNTRUSTED) |
| `browser_screenshot()` | base64 PNG of the current page |
| `browser_click(selector)` | click; landing URL is re-checked against the allowlist |
| `browser_close()` | tear down the ephemeral browser |

## Threat analysis

- **Prompt injection via page content.** The CLI treats page text as data, never
  instruction. Any path that feeds `browser_read` output back into a model prompt
  must wrap it with the untrusted-content envelope (`lib/untrusted.ts`, the
  repo's standing convention). The **domain allowlist is the mechanical
  backstop**: even if injected text convinces the model to "go to attacker.net",
  navigation there is refused, and a click that lands off-list closes the
  browser.
- **Credential exfiltration.** **Impossible in v1** — there is no profile,
  cookie, or logged-in session. There is nothing for a hostile page to read out
  of the browser, and the agent can never "sign in as you" because there is no
  saved account.
- **Quota / runaway.** Per-task page budget + wall-clock cap stop a loop that
  keeps opening pages or spins forever.
- **Self-escalation.** The opt-in file is on `SECRET_PATHS`, so a tool-run agent
  cannot flip the flag with a Write; only the guarded `/api/browser-rails` route
  (session-token, JSON-only) writes it.

## Payload / download cost

Playwright is an **optional dependency**, loaded lazily. The browser binary
(Chromium, **~150 MB**) is **not** part of the shipped customer payload; it
downloads on **first enable**. This is disclosed in the consent copy. If the
component is absent, every tool degrades to a plain-language "browser tools are
not installed yet" message rather than crashing.

## Phase 1 vs Phase 2 (honest boundary)

**Built + tested (against a mocked driver, no Playwright/browser in CI):**
- flag config + gating (`config.ts`), allowlist enforcement (`allowlist.ts`),
  the tool rails + budget + graceful-degrade (`tools.ts`), the real Playwright
  driver (`driver.ts`), the gated CLI-wiring seam (`registration.ts`), the
  `/api/browser-rails` consent route, and the Settings toggle.

**Phase 2 (not yet implemented):**
- The stdio **MCP server process** that exposes these five tools to the spawned
  Claude CLI (needs the `@modelcontextprotocol` SDK vendored; the app currently
  only has `@playwright/mcp`, which does not carry OUR rails). `registration.ts`
  is the seam it plugs into.
- Wiring `browserRailsCliWiring()` into `lib/providers/claude.ts`'s spawn args
  next to the existing `--mcp-config`.
- The per-task "declare + approve domains" UI handshake (Phase 1 approves the
  allowlist programmatically at session construction).

## Files

- `lib/browser-rails/config.ts` — flag, budget constants, download-size copy
- `lib/browser-rails/allowlist.ts` — domain normalization + URL checks
- `lib/browser-rails/driver.ts` — `BrowserDriver` interface + lazy Playwright driver
- `lib/browser-rails/tools.ts` — `BrowserSession` (flag gate, allowlist, budget)
- `lib/browser-rails/registration.ts` — gated CLI-wiring seam
- `app/api/browser-rails/route.ts` — consent GET/POST
- `components/SettingsPanel.tsx` — Settings → Privacy toggle
- `tests/browser-rails.test.ts` — flag gating, allowlist, budget, degrade
