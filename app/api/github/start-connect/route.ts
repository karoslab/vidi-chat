import { requireWriteAuth, requireJsonContentType } from "@/lib/origin";
import { status, startDeviceFlow, cancelPendingFlow, NOT_INSTALLED_MSG } from "@/lib/github-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST /api/github/start-connect → begin GitHub's device-code flow and return
 * the one-time code + the page to open. NO token is ever returned to the browser
 * — gh keeps the credential in the system keychain; the browser only ever sees
 * the short display code the customer types into github.com themselves.
 *
 * Write-gated (this grants a capability). If the account is already connected we
 * short-circuit — gh would otherwise prompt to re-authenticate, which the device
 * parser can't answer. Each call mints a FRESH code (startDeviceFlow cancels any
 * previous in-flight poller), so "Open the page again" is just another POST.
 */
export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badType = requireJsonContentType(req);
  if (badType) return badType;

  const existing = await status();
  if (existing.notInstalled) {
    return Response.json(
      { error: NOT_INSTALLED_MSG, kind: "not-installed" },
      { status: 503 }
    );
  }
  if (existing.connected) {
    return Response.json({ connected: true, login: existing.login });
  }

  try {
    const flow = await startDeviceFlow();
    // The flow's gh process keeps polling in the background; the client polls
    // /api/github/status to learn when the customer has finished on GitHub. We
    // intentionally do NOT await flow.completion here.
    return Response.json({
      connected: false,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
    });
  } catch (e) {
    cancelPendingFlow();
    return Response.json(
      { error: (e as Error).message || "Couldn't start the connection. Please try again.", kind: "unknown" },
      { status: 502 }
    );
  }
}
