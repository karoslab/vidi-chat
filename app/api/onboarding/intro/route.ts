import { getOrCreateIntroThread } from "@/lib/intro-thread";
import { STARTER_PROMPTS } from "@/lib/onboarding";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Onboarding intro chat (T2.2).
 *
 * GET → { thread, starters } — find-or-create the single "intro" thread
 *       (seeded with Vidi's deterministic tone-flavored greeting, no model
 *       call) and the five starter prompts to render as tappable cards. The
 *       user's replies continue this thread via the normal /api/chat route.
 *
 * Vidi's identity is fixed (product ruling 2026-07-05) — the intro no longer
 * captures a name, so there is no POST handler.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const thread = getOrCreateIntroThread();
  return Response.json({ thread, starters: STARTER_PROMPTS });
}
