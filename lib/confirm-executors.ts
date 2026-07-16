import fs from "node:fs";
import path from "node:path";
import { registerExecutor } from "./confirm.ts";
import { getUserConfig } from "./user-config.ts";
import { checkWriteFileTarget } from "./write-file-jail.ts";
import { handsAct } from "./hands.ts";
import { startTerminal, TerminalCwdError } from "./terminals.ts";
import { isKillEngaged } from "./kill.ts";
import {
  CALENDAR_EVENTS_SCOPE,
  GMAIL_SEND_SCOPE,
  createCalendarEvent,
  hasScope,
  sendEmail,
} from "./gws.ts";

/**
 * Server-side executors for the durable confirm registry (lib/confirm.ts). Each
 * executor is a pure async function of the persisted `payload` — no closures,
 * no RAM state — so a `{kind, payload}` record filed before a restart runs
 * correctly after it. Imported once for its side effect by lib/confirm.ts.
 *
 * The four kinds mirror the vidi-act verb table's targets:
 *   - "hands"        → POST :4184/act with the payload (GUI / system actuation)
 *   - "gws-email"    → gws gmail send, gated on the gmail.send scope
 *   - "gws-calendar" → gws calendar create, gated on the calendar.events scope
 *   - "write-file"   → write a file (used for out-of-jail paths the CLI blocks)
 *
 * An executor RETURNS spoken text on both success and an honest, expected
 * failure (e.g. missing Google scope) so the voice route speaks it verbatim. It
 * THROWS only on an unexpected error, which confirmPending turns into the
 * generic "I tried, but that didn't go through."
 */

function gwsReauthMessage(): string {
  return `I need ${getUserConfig().displayName} to re-authorize Google first.`;
}

/**
 * shell: run a shell command as a managed terminal (B3/P2). Reached ONLY after
 * the owner-only control-route `shell` verb PARKED it and a human approved via
 * the P1 token+nonce gate — the confirm queue is the human gate the raw verb
 * lacked. startTerminal detaches + logs; we speak the pid so the approval has a
 * visible result. Throws only on a missing cmd (→ generic "didn't go through").
 */
registerExecutor("shell", async (payload) => {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const cmd = String(p.cmd ?? "").trim();
  if (!cmd) throw new Error("no cmd");
  const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd : undefined;
  let term;
  try {
    term = startTerminal(cmd, cwd);
  } catch (err) {
    // A nonexistent (or "~"-prefixed, formerly never-expanded) cwd used to spawn
    // with pid `undefined` — a false "success (pid -1)" spoken to the approver —
    // and then crash the whole vidi-chat server on an unhandled 'error' event
    // (audit finding 11). startTerminal now validates the cwd before spawning and
    // throws this typed error; return a speakable refusal (executor RETURN = spoken
    // verbatim) instead of a false pid or a crash.
    if (err instanceof TerminalCwdError) {
      return `I can't run that — the folder ${err.attemptedCwd} doesn't exist.`;
    }
    throw err;
  }
  return `Started that — it's running now (pid ${term.pid}).`;
});

/** hands: relay the payload straight to the native Hands /act contract. */
registerExecutor("hands", async (payload) => {
  // Re-check the kill switch at ACTUATION time, not just when the action was
  // parked (P2): approval happens up to 120s after the propose, and an emergency
  // stop engaged in that window must still block the mouse/keyboard move. The
  // control route checks kill at park time; this is the matching check at the
  // moment the GUI action would actually fire. Fail closed — a spoken refusal,
  // never an actuation — so the kill switch stays a real emergency stop.
  if (isKillEngaged()) {
    return "The kill switch is engaged — I won't touch the Mac controls until you clear it.";
  }
  const action = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const r = await handsAct(action);
  if (!r) return "I couldn't reach the Mac controls.";
  if (r.ok === false) return typeof r.error === "string" ? r.error : "That didn't go through.";
  return typeof r.say === "string" && r.say.length > 0 ? r.say : "Done.";
});

/** gws-email: send mail, but only if the gmail.send scope is actually granted. */
registerExecutor("gws-email", async (payload) => {
  if (!(await hasScope(GMAIL_SEND_SCOPE))) return gwsReauthMessage();
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  return sendEmail({
    // Defensive aliasing (audit finding 1): the vidi-act shim normalizes these,
    // but a record filed by another caller — or hand-written before the shim
    // aliased them — must still send correctly rather than silently drop the
    // recipient (recipient→to) or send an EMPTY body (message/content→body).
    to: String(p.to ?? p.recipient ?? ""),
    subject: String(p.subject ?? ""),
    body: String(p.body ?? p.message ?? p.content ?? ""),
    // cc/bcc were silently dropped before (audit finding 2): the sent email
    // wasn't the approved email. Forward them when present.
    cc: p.cc != null ? String(p.cc) : undefined,
    bcc: p.bcc != null ? String(p.bcc) : undefined,
  });
});

/** gws-calendar: create an event, gated on the calendar.events scope. */
registerExecutor("gws-calendar", async (payload) => {
  if (!(await hasScope(CALENDAR_EVENTS_SCOPE))) return gwsReauthMessage();
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  return createCalendarEvent({
    // "title" is the model-natural alias for Google's "summary" — records
    // filed before the vidi-act shim normalized it (or by other callers)
    // must still execute, not throw into "that didn't go through".
    summary: String(p.summary ?? p.title ?? ""),
    start: String(p.start ?? ""),
    end: String(p.end ?? ""),
  });
});

/**
 * write-file: write a file at an absolute path. The vidi-act shim only routes a
 * write here when the target is OUTSIDE the CLI's own write jail (~/Desktop,
 * ~/Downloads are handled direct via --add-dir; the confirm path is for
 * anywhere else, e.g. ~/Documents). Confirm is the human gate for those.
 */
registerExecutor("write-file", async (payload) => {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const filePath = String(p.path ?? "").trim();
  // Defensive aliasing (audit finding 15): the executor reading ONLY `content`
  // meant a payload keyed {text}/{contents} silently wrote a ZERO-BYTE file and
  // reported success — destroying an existing file after an approval that only
  // described the path. Mirror the vidi-act shim's alias here so a record filed
  // by any caller writes the real content. An explicit content:"" stays "".
  const content =
    typeof p.content === "string"
      ? p.content
      : typeof p.text === "string"
        ? p.text
        : typeof p.contents === "string"
          ? p.contents
          : "";
  if (!filePath) throw new Error("no path");
  // Phase 4a — H4: jail the target. Even an approved confirm (token+nonce gated;
  // B1 defense-in-depth) can only write inside {workspace, Desktop, Downloads},
  // never a SECRET_PATHS credential/token or a $HOME dotfile. A refusal is a
  // spoken plain-language "no", NOT a throw (a throw would surface as the
  // generic "that didn't go through").
  const jail = checkWriteFileTarget(filePath);
  if (!jail.allowed) return jail.reason ?? "I can't write to that location.";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return `Wrote ${filePath}.`;
});
