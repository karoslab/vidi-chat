import { NextRequest } from "next/server";
import { requireJsonContentType, requireWriteAuth } from "@/lib/origin";
import {
  defaultTierRun,
  initialState,
  isReady,
  recordAnswer,
  renderBriefMarkdown,
  saveBrief,
  synthesizeBrief,
  type PrompterAnswer,
  REQUIRED_TOPICS,
} from "@/lib/prompter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { answers: PrompterAnswer[] } → synthesize the Build Brief (DEEP tier),
 * save it as v1, and return the readable result. WRITE-gated (drives a model
 * turn and writes the brief to disk).
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
    /* defaults */
  }
  const answers: PrompterAnswer[] = Array.isArray(body.answers) ? body.answers : [];

  let state = initialState();
  // One-shot path (2026-07-12 customer ask): the whole idea in a single dump,
  // no question walk. The dump becomes the idea answer; the other required
  // topics are marked as inferable so isReady holds and the synthesis model
  // reads everything from the dump.
  if (typeof body.rawDump === "string" && body.rawDump.trim()) {
    const dump = body.rawDump.trim().slice(0, 8000);
    state = recordAnswer(state, { topic: "idea", text: dump });
    for (const t of REQUIRED_TOPICS) {
      if (t === "idea") continue;
      state = recordAnswer(state, {
        topic: t,
        text: "Not asked separately. Read the idea description and choose something sensible and simple.",
      });
    }
  }
  for (const a of answers) {
    if (a && typeof a.topic === "string") state = recordAnswer(state, a);
  }
  if (!isReady(state)) {
    return Response.json(
      { error: "a few more answers are needed before we can plan this" },
      { status: 400 }
    );
  }

  try {
    const brief = await synthesizeBrief(state, defaultTierRun);
    const saved = saveBrief(brief, { reason: "Created from your answers" });
    return Response.json({
      slug: saved.slug,
      version: saved.version,
      brief: saved.brief,
      markdown: renderBriefMarkdown(saved.brief),
    });
  } catch {
    return Response.json(
      { error: "I could not build your brief just now. Please try again." },
      { status: 500 }
    );
  }
}
