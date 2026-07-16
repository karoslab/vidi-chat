import { execFile } from "node:child_process";

/**
 * Thin server-side wrapper over the `gws` (Google Workspace) CLI. Vidi rides
 * the CLI's own local OAuth — no API key, no in-process OAuth (see the plan's
 * anti-pattern #2). Writes (gmail send, calendar event create) only run AFTER a
 * voice confirm, from lib/confirm-executors.ts.
 *
 * ## Runtime scope gating (W3, step 5)
 *
 * The gws CLI can be authorized with a *subset* of scopes. Before we attempt an
 * email send or calendar create, we check the *granted* scopes (`gws auth
 * status` → `scopes[]`). If the required write scope is missing, we DON'T try
 * the write and DON'T prompt for consent from the server — instead the confirm
 * executor returns an honest, speakable failure and the route says it out loud:
 * "I need the user to re-authorize Google first."
 *
 * Scope status is cached ~5 min so a rapid burst of confirms doesn't shell out
 * repeatedly. Re-authorization is out-of-band (operator reconnects Google); the
 * cache expiry means a fresh grant is picked up within 5 minutes with no
 * restart, and a restart picks it up immediately.
 */

/** Google OAuth scope URIs required for each write capability. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const CALENDAR_EVENTS_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

const SCOPE_CACHE_TTL_MS = 5 * 60_000;

interface ScopeCache {
  scopes: string[];
  fetchedAt: number;
}
let scopeCache: ScopeCache | null = null;

/** Run a gws subcommand, resolving stdout. Rejects with stderr on nonzero. */
function runGws(
  args: string[],
  timeoutMs = 30_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gws",
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || "").toString().trim();
          reject(new Error(detail || "gws failed"));
          return;
        }
        resolve(stdout.toString());
      }
    );
  });
}

/**
 * Return the currently granted OAuth scopes, cached ~5 min. Fails open to an
 * empty list on any error (parse failure, CLI missing) — an empty list means
 * "no write scopes", so the caller gates safely rather than attempting a write.
 */
export async function grantedScopes(
  opts: { now?: number; force?: boolean } = {}
): Promise<string[]> {
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  // Test/CI seam: a comma-separated scope list forces the answer WITHOUT
  // shelling out to the real gws CLI. Never set in production.
  if (typeof process.env.VIDI_GWS_SCOPES_OVERRIDE === "string") {
    return process.env.VIDI_GWS_SCOPES_OVERRIDE.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (
    !opts.force &&
    scopeCache &&
    now - scopeCache.fetchedAt < SCOPE_CACHE_TTL_MS
  ) {
    return scopeCache.scopes;
  }
  let scopes: string[] = [];
  try {
    const out = await runGws(["auth", "status"], 15_000);
    // gws prints a keyring banner on stderr and the JSON on stdout; but be
    // defensive and slice from the first '{' in case anything leaks in.
    const start = out.indexOf("{");
    const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
    if (Array.isArray(parsed.scopes)) {
      scopes = parsed.scopes.filter((s: unknown): s is string => typeof s === "string");
    }
  } catch {
    scopes = [];
  }
  scopeCache = { scopes, fetchedAt: now };
  return scopes;
}

/** Clear the scope cache (tests; also called if a grant is known to change). */
export function clearScopeCache(): void {
  scopeCache = null;
}

/** True iff the given scope is currently granted (cached). */
export async function hasScope(
  scope: string,
  opts: { now?: number } = {}
): Promise<boolean> {
  const scopes = await grantedScopes(opts);
  return scopes.includes(scope);
}

/**
 * Build the argv for `gws gmail +send` using the JOINED `--flag=value` form for
 * every value. clap (the gws CLI's parser) rejects an option value passed as a
 * SEPARATE argv token when that token starts with "-" — so a model-natural body
 * that begins with a hyphen (a bulleted "- milk\n- rent", a "- Vidi" signature)
 * or a "-urgent" subject crashed the entire send with exit 3, AFTER the operator had
 * already spoken confirm (audit finding 0). The `--flag=value` form is
 * hyphen-safe (verified: `--body=- milk` dry-runs exit 0; the separate-token
 * form exits 3). cc/bcc are forwarded only when present — they were silently
 * dropped before, so the email that sent was not the email that was approved
 * (audit finding 2). Pure and exported so the argv shape is unit-testable
 * without shelling out to the real gws CLI.
 */
export function buildGmailSendArgs(payload: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): string[] {
  const args = [
    "gmail",
    "+send",
    `--to=${payload.to}`,
    `--subject=${payload.subject}`,
    `--body=${payload.body}`,
  ];
  const cc = String(payload.cc || "").trim();
  const bcc = String(payload.bcc || "").trim();
  if (cc) args.push(`--cc=${cc}`);
  if (bcc) args.push(`--bcc=${bcc}`);
  return args;
}

/**
 * Send an email via the `gws gmail +send` helper. Caller MUST have gated on
 * {@link GMAIL_SEND_SCOPE} first. Returns spoken confirmation text.
 * (`gws gmail messages send --json` does not exist in the gws CLI — the
 * original spelling had never been executed until 2026-07-09 and failed on
 * first live use.)
 */
export async function sendEmail(payload: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): Promise<string> {
  const to = String(payload.to || "").trim();
  const subject = String(payload.subject || "").trim();
  const body = String(payload.body || "");
  const cc = String(payload.cc || "").trim();
  const bcc = String(payload.bcc || "").trim();
  if (!to) throw new Error("no recipient");
  await runGws(buildGmailSendArgs({ to, subject, body, cc, bcc }));
  // Speak the cc back so the confirmation matches the email that actually sent.
  return `Sent your email to ${to}${cc ? `, cc ${cc}` : ""}.`;
}

/**
 * The model speaks in local wall-clock time ("2026-07-10T17:00:00", no zone)
 * but the Google Calendar API rejects a bare dateTime with "Missing time zone
 * definition" — proven live 2026-07-09 on the first offset-less insert. Append
 * this Mac's UTC offset for THAT instant (computed from the parsed local time,
 * so DST is handled per-date, not per-today). Values already carrying Z or a
 * ±HH:MM offset pass through untouched, as does anything unparseable or
 * date-only (let the API report those honestly).
 */
export function ensureRfc3339Offset(dateTime: string): string {
  let trimmed = dateTime.trim();
  // Accept a SPACE-separated local datetime ("2026-07-10 17:00[:SS]") — a shape
  // V8's Date parses happily and the model can emit, but the old includes("T")
  // gate let it pass through unchanged into a zone-less API insert Google
  // rejects post-confirm (audit finding 19). Normalize the strict date-then-time
  // form to the T form so the rest of the logic applies; a loose "Tomorrow at 5"
  // does NOT match this pattern and still passes through untouched.
  const spaceSeparated =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)$/.exec(trimmed);
  if (spaceSeparated) trimmed = `${spaceSeparated[1]}T${spaceSeparated[2]}`;
  // Only an ISO-shaped LOCAL dateTime gets normalized — V8's lenient Date
  // parser accepts junk like "Tomorrow at 5", which must pass through for the
  // API to report honestly instead of gaining a nonsense offset.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return trimmed;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return trimmed;
  // RFC3339 partial-time REQUIRES seconds (HH:MM:SS). A model commonly emits a
  // seconds-less "...T17:00"; without this the offset appended below yields
  // "2026-07-10T17:00-05:00", which is not valid RFC3339 and Google rejects
  // post-confirm (audit findings 3, 35). Add ":00" before appending the offset.
  if (/T\d{2}:\d{2}$/.test(trimmed)) trimmed = `${trimmed}:00`;
  const parsedAsLocalTime = new Date(trimmed);
  if (Number.isNaN(parsedAsLocalTime.getTime())) return trimmed;
  const offsetMinutes = -parsedAsLocalTime.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const minutes = String(absMinutes % 60).padStart(2, "0");
  return `${trimmed}${sign}${hours}:${minutes}`;
}

/**
 * Create a calendar event via the `gws calendar +insert` helper. Caller MUST
 * have gated on {@link CALENDAR_EVENTS_SCOPE} first. Returns spoken
 * confirmation. (`gws calendar events create --json` does not exist in the
 * gws CLI — first live execution 2026-07-09 failed with
 * "unrecognized subcommand 'create'".)
 */
export async function createCalendarEvent(payload: {
  summary: string;
  start: string;
  end: string;
}): Promise<string> {
  const summary = String(payload.summary || "").trim();
  const start = String(payload.start || "").trim();
  const end = String(payload.end || "").trim();
  if (!summary || !start) throw new Error("event needs a summary and start time");
  // A date-only start ("2026-07-11", i.e. an all-day / "block Friday" ask) can't
  // ride this path: the gws CLI ships it verbatim as a zone-less `dateTime` that
  // Google rejects AFTER the spoken confirm — the same never-executed live
  // failure class as the offset-less time (audit finding 34). Return a speakable
  // ask for a time of day instead of throwing into the generic "didn't go
  // through" (an executor RETURN is spoken verbatim, like gwsReauthMessage()).
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return "I need a time of day for that event — what time should it start?";
  }
  // Sibling of the start guard above (QA follow-up to audit finding 34): a
  // TIMED start with a date-only END ("start 5pm, end 2026-07-11") still ships
  // `--end=2026-07-11` zone-less and Google rejects it post-confirm — the guard
  // above only covered a date-only START. Same fix, same spirit: a speakable ask
  // instead of a doomed send. (An end that's simply omitted still defaults to
  // `start` below, which is already known to be timed at this point.)
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return "I need a time of day for when that event ends — what time should it end?";
  }
  await runGws(
    buildCalendarInsertArgs({
      summary,
      start: ensureRfc3339Offset(start),
      end: ensureRfc3339Offset(end || start),
    })
  );
  return `Added "${summary}" to your calendar.`;
}

/**
 * Build the argv for `gws calendar +insert` using the JOINED `--flag=value` form
 * for every value — hyphen-safe for the same reason as {@link buildGmailSendArgs}
 * (an event named "- standup" would otherwise crash clap with exit 3 after the
 * spoken confirm; audit finding 0). Pure and exported for unit testing.
 */
export function buildCalendarInsertArgs(payload: {
  summary: string;
  start: string;
  end: string;
}): string[] {
  return [
    "calendar",
    "+insert",
    `--summary=${payload.summary}`,
    `--start=${payload.start}`,
    `--end=${payload.end}`,
  ];
}
