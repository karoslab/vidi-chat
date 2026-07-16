import { NextRequest } from "next/server";
import { requireJsonContentType, requireWriteAuth } from "@/lib/origin";
import { getProvider } from "@/lib/providers";
import { actModeAllowed } from "@/lib/user-config";
import { briefBuildSeed, loadBrief } from "@/lib/prompter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { slug } → decide whether Vidi can build this now.
 *   available:true  + seed  → the caller hands `seed` to POST /api/chat with
 *     mode "auto" (the ordinary thread-creation + turn path — no parallel build
 *     mechanism). The brief IS the task.
 *   available:false + explanation → this install can only plan, not act; the UI
 *     shows the plain-language reason and offers to keep refining the brief.
 * WRITE-gated.
 */
export async function POST(req: NextRequest) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badType = requireJsonContentType(req);
  if (badType) return badType;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const slug = typeof body.slug === "string" ? body.slug : "";
  const stored = loadBrief(slug);
  if (!stored) return Response.json({ error: "not found" }, { status: 404 });

  const providerOk = getProvider("claude") !== null;
  if (!actModeAllowed() || !providerOk) {
    return Response.json({
      available: false,
      explanation:
        "This setup can plan your idea with you, but it cannot build it on its " +
        "own yet. We can keep shaping the plan together, and someone can turn " +
        "on building later.",
    });
  }

  return Response.json({
    available: true,
    mode: "auto",
    provider: "claude",
    seed: briefBuildSeed(stored.brief),
  });
}
