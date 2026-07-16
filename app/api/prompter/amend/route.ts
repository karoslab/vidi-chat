import { NextRequest } from "next/server";
import { requireJsonContentType, requireWriteAuth } from "@/lib/origin";
import {
  applyAmendment,
  coerceBrief,
  defaultTierRun,
  loadBrief,
  proposeAmendment,
  renderBriefMarkdown,
} from "@/lib/prompter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mid-project intake.
 *   POST { slug, ideas }        → propose an amendment (DEEP tier): before/after
 *                                 per changed section, nothing saved yet.
 *   POST { slug, apply, brief } → save an approved amendment as v(n+1).
 * WRITE-gated (drives a model turn / writes the brief).
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
  const current = loadBrief(slug);
  if (!current) return Response.json({ error: "not found" }, { status: 404 });

  if (body.apply) {
    const saved = applyAmendment(slug, coerceBrief(body.brief));
    return Response.json({
      slug: saved.slug,
      version: saved.version,
      brief: saved.brief,
      markdown: renderBriefMarkdown(saved.brief),
    });
  }

  const ideas = typeof body.ideas === "string" ? body.ideas : "";
  if (!ideas.trim()) {
    return Response.json({ error: "share a few ideas first" }, { status: 400 });
  }
  const proposal = await proposeAmendment(current, ideas, defaultTierRun);
  return Response.json(proposal);
}
