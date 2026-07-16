import { NextRequest } from "next/server";
import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";
import {
  BRIEF_SECTIONS,
  editBriefSection,
  loadBrief,
  renderBriefMarkdown,
  type BriefSectionKey,
} from "@/lib/prompter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const SECTION_KEYS = new Set(BRIEF_SECTIONS.map((s) => s.key));

/** GET ?slug=… → the readable brief + markdown. Read-gated. */
export async function GET(req: NextRequest) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const slug = req.nextUrl.searchParams.get("slug") || "";
  const stored = loadBrief(slug);
  if (!stored) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({
    slug: stored.slug,
    version: stored.version,
    brief: stored.brief,
    markdown: renderBriefMarkdown(stored.brief),
  });
}

/**
 * POST { slug, section, value } → edit one section inline, re-save, append
 * history. WRITE-gated (persists the brief).
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
  const section = body.section as BriefSectionKey;
  const value = typeof body.value === "string" ? body.value : "";
  if (!SECTION_KEYS.has(section)) {
    return Response.json({ error: "unknown section" }, { status: 400 });
  }
  const saved = editBriefSection(slug, section, value);
  if (!saved) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({
    slug: saved.slug,
    version: saved.version,
    brief: saved.brief,
    markdown: renderBriefMarkdown(saved.brief),
  });
}
