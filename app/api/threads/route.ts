import { NextRequest } from "next/server";
import { createThread, isTurnRunning, listThreads } from "@/lib/store";
import { normalizeEffort, normalizeMode } from "@/lib/models";
import { getProvider } from "@/lib/providers";
import { requireReadAuth, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** GET → thread list (titles/models). Token gated (Tier-2). */
export async function GET(req: NextRequest) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({
    threads: listThreads().map((t) => ({ ...t, running: isTurnRunning(t.id) })),
  });
}

/** POST → create a thread. WRITE-gated (2026-07-07 fresh-context review):
 *  this mutates state (createThread → saveThread), so it takes
 *  requireWriteAuth — {session, control} only. It previously shared GET's
 *  requireReadAuth, which was harmless while the two gates were
 *  token-identical, but requireReadAuth now also admits the phone token
 *  (read-only surface) and must not grant thread creation. */
export async function POST(req: NextRequest) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* defaults */
  }
  const providerId = body.provider || "claude";
  if (!getProvider(providerId)) {
    return Response.json({ error: `unknown provider: ${providerId}` }, { status: 400 });
  }
  const thread = createThread(
    providerId,
    body.model ?? null,
    body.mode ? normalizeMode(body.mode) : "plan",
    body.effort ? normalizeEffort(body.effort) : undefined
  );
  return Response.json({ thread });
}
