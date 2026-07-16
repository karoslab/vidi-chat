import { INTERVIEW_QUESTIONS, runInterview, scaffoldWiki } from "@/lib/memory-wiki";
import { requireWriteAuth, requireReadAuth, requireJsonContentType } from "@/lib/origin";
import { appendJournal } from "@/lib/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** GET -> the five questions to show the customer. READ-gated. */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ questions: INTERVIEW_QUESTIONS });
}

/**
 * POST { answers: { [questionId]: string } } -> distill the answers into linked
 * notes on the worker tier and write them. WRITE-gated: it writes notes and
 * commits. Ensures the wiki exists first so the interview can stand alone.
 */
export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badType = requireJsonContentType(req);
  if (badType) return badType;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* validated below */
  }
  const answers = body?.answers;
  if (!answers || typeof answers !== "object") {
    return Response.json({ error: "answers are required" }, { status: 400 });
  }
  // Keep only string answers for the known questions (never trust extra keys).
  const clean: Record<string, string> = {};
  for (const q of INTERVIEW_QUESTIONS) {
    const v = answers[q.id];
    if (typeof v === "string" && v.trim()) clean[q.id] = v;
  }
  if (Object.keys(clean).length === 0) {
    return Response.json({ error: "Answer at least one question first." }, { status: 400 });
  }

  try {
    scaffoldWiki();
    const result = await runInterview(clean);
    appendJournal({
      ts: Date.now(),
      threadId: "memory",
      tool: "memory-interview",
      summary: `${result.written} notes`,
    });
    return Response.json({ ok: true, ...result });
  } catch {
    return Response.json(
      { error: "I could not build your notes just now. Please try again." },
      { status: 500 }
    );
  }
}
