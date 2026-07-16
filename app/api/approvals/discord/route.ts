import { requireReadAuth, requireWriteAuth, requireJsonContentType } from "@/lib/origin";
import {
  getWebhookConfig,
  setWebhookUrl,
  clearWebhook,
  sendTestPing,
  WebhookValidationError,
} from "@/lib/discord-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * The guided Discord webhook setup surface.
 *
 * GET  → current connection state (never echoes the raw URL — it's a capability).
 * POST → save a pasted webhook URL and run the MANDATORY test ping, OR clear it.
 *        Save is not "done" until the test ping returns 2xx (item 5).
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const cfg = getWebhookConfig();
  return Response.json({
    configured: cfg.configured,
    connected: cfg.lastTestPingOk,
    lastTestPingAt: cfg.lastTestPingAt,
  });
}

export async function POST(req: Request) {
  const badType = requireJsonContentType(req);
  if (badType) return badType;
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;

  let body: { url?: unknown; clear?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  if (body.clear === true) {
    clearWebhook();
    return Response.json({ configured: false, connected: false });
  }

  if (typeof body.url !== "string") {
    return Response.json({ error: "paste your webhook link" }, { status: 400 });
  }

  try {
    setWebhookUrl(body.url);
  } catch (err) {
    if (err instanceof WebhookValidationError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return Response.json({ error: "couldn't save that link" }, { status: 500 });
  }

  // Mandatory test ping: the setup isn't connected until this returns 2xx.
  const ping = await sendTestPing();
  if (!ping.ok) {
    return Response.json(
      {
        configured: true,
        connected: false,
        error:
          "Saved your link, but the test message didn't get through. Check the link and paste it again.",
      },
      { status: 502 }
    );
  }
  return Response.json({ configured: true, connected: true });
}
