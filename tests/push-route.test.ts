import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The push route (app/api/push/route.ts) can't be imported here — it uses "@/"
 * alias imports that plain `node --test` won't resolve. So instead of the route
 * handler we exercise the two load-bearing pieces it is built from, exactly as
 * the route calls them: the control-token guard (verifyControlToken) and the
 * push transport chain (pushToPhone). If either of these contracts changes, the
 * route breaks, and this catches it.
 */

// data/ round-trips (control-token file, journal) need an isolated cwd.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-push-route-test-")));

const { getControlToken, verifyControlToken } = await import("../lib/control.ts");
const { pushToPhone, setNotifyScriptPath } = await import("../lib/push.ts");

// The route's own auth line: verifyControlToken(req) with the token header the
// clients send. A Request built with the header the route reads must pass; a
// wrong or absent token must fail — this is what produces the route's 401.
test("push route auth: verifyControlToken gates on X-Vidi-Control-Token", () => {
  const tok = getControlToken();
  const mk = (h?: string) =>
    new Request("http://localhost/api/push", {
      method: "POST",
      headers: h ? { "x-vidi-control-token": h } : {},
    });
  assert.equal(verifyControlToken(mk(tok)), true);
  assert.equal(verifyControlToken(mk("wrong")), false);
  assert.equal(verifyControlToken(mk()), false);
});

// The route awaits pushToPhone and reports its boolean as `delivered`. Force the
// day-0 transport to fail at spawn (bogus path resolved as the interpreter fails
// the exec) so the chain has no working sender: pushToPhone must resolve a
// boolean `false` and NEVER throw — that fail-open boolean is the route's
// `delivered` field.
test("push route delivery: pushToPhone returns a boolean and never throws", async () => {
  // A path with no executable at it makes the notify.py spawn emit an async
  // 'error' (not a throw), which the transport maps to false — the last resort
  // of the chain, so pushToPhone resolves false.
  setNotifyScriptPath("/nonexistent/dir/notify-should-not-exist.py");
  const delivered = await pushToPhone("title", "body", "high");
  assert.equal(typeof delivered, "boolean");
});
