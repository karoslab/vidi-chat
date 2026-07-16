import { NextRequest } from "next/server";
import { requireJsonContentType, requireWriteAuth } from "@/lib/origin";
import { plainLanguageProviderError } from "@/lib/provider-error";
import {
  adaptQuestion,
  defaultTierRun,
  initialState,
  nextQuestion,
  recordAnswer,
  type PrompterAnswer,
} from "@/lib/prompter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { answers: PrompterAnswer[] } → the next guided question (or ready:true
 * when enough is answered to plan). Question wording adapts to the customer's
 * prior words on the WORKER tier (defaultTierRun). WRITE-gated: it drives a
 * model turn.
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
  for (const a of answers) {
    if (a && typeof a.topic === "string") state = recordAnswer(state, a);
  }

  const base = nextQuestion(state);
  if (!base) {
    return Response.json({ ready: true, question: null });
  }
  try {
    const question = await adaptQuestion(base, state, defaultTierRun);
    return Response.json({ ready: false, question });
  } catch (err) {
    // The model is optional here — never block the flow on it.
    return Response.json({
      ready: false,
      question: base,
      note: plainLanguageProviderError((err as Error)?.message),
    });
  }
}
