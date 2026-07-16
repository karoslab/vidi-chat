import { requireReadAuth } from "@/lib/origin";
import { listPendingWork } from "@/lib/approvals";
import { getWebhookConfig } from "@/lib/discord-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * GET → the customer's pending work (open PRs across their project repos) mapped
 * to plain-language cards, plus whether the Discord mirror is connected. Read
 * surface — requireReadAuth. Never mutates anything.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;

  const cards = await listPendingWork();
  const webhook = getWebhookConfig();
  return Response.json({
    cards,
    discord: { configured: webhook.configured, connected: webhook.lastTestPingOk },
  });
}
