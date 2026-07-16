import { requireReadAuth, requireWriteAuth, requireJsonContentType } from "@/lib/origin";
import {
  installClaude,
  getInstallState,
  readInstallLogTail,
  claudeStatus,
  loginState,
} from "@/lib/claude-setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Connect Claude — install (Phase A of the Helper demotion).
 *
 * POST → kick off the CLI install (METHOD 1 official installer → METHOD 2 npm
 *        fallback) and return IMMEDIATELY; the work runs in the background.
 *        Write-gated + JSON content type. Single-flight lives in installClaude()
 *        so a double-tap can't launch two installs. The command strings are
 *        FIXED (constants / trusted env) — zero request input reaches any shell.
 *
 * GET  → poll: { phase, logTail, done, ok, connection, login }. Read-gated.
 *        `connection` is the missing/signed-out/signed-in tri-state the step
 *        screen branches on; phase/logTail/done/ok drive the live install
 *        progress + collapsible log; `login` (Phase B) is the PTY sign-in state
 *        { state, url?, method? } the step reads to show the "Open the sign-in
 *        page" button and auto-flip green on completion. `login` is additive —
 *        Phase A consumers ignore it.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const s = getInstallState();
  const connection = await claudeStatus();
  return Response.json({
    phase: s.phase,
    done: s.done,
    ok: s.ok,
    logTail: readInstallLogTail(),
    connection,
    login: loginState(),
  });
}

export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  // Fire and forget — the client polls GET for progress. installClaude() is
  // single-flight, so an in-flight install is reused rather than duplicated.
  void installClaude();
  const s = getInstallState();
  return Response.json({ started: true, phase: s.phase });
}
