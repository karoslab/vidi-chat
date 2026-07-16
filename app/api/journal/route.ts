import { readJournal } from "@/lib/journal";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * GET → { entries: [{ts, threadId, tool, summary}] } — latest 50, newest first.
 * Token gated (requireReadAuth — Tier-2): the journal exposes act-mode tool
 * history, thread ids and absolute paths, so it must not be an open read over
 * the tailscale-serve exposure. The browser drawer sends the injected session
 * token; a tailnet peer has none → 401.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ entries: readJournal(50) });
}
