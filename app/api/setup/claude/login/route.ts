import { requireWriteAuth, requireJsonContentType } from "@/lib/origin";
import { startLogin } from "@/lib/claude-setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Connect Claude — sign in (Phase A of the Helper demotion).
 *
 * POST → spawn the CLI's interactive login (the CLI opens the customer's browser
 *        to sign in with THEIR OWN account) exactly like the Helper menu does,
 *        and return { spawned }. Write-gated + JSON content type. The verb is
 *        discovered from the CLI's own --help (never a request-supplied string),
 *        and no request input reaches the spawn.
 *
 * This is the v1 blind spawn; Phase B replaces startLogin()'s internals with a
 * PTY driver behind the same { spawned } interface. After the browser sign-in,
 * the customer taps the step's Re-check, which re-runs the journey verify
 * (claudeStatus) and turns the step green.
 */
export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  const result = await startLogin();
  return Response.json(result);
}
