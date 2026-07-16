import { NextRequest } from "next/server";
import { requireJsonContentType, requireWriteAuth } from "@/lib/origin";
import {
  createThread,
  getThread,
  listThreads,
  saveThread,
  updateThread,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vision-history archive — the Mac app posts every screenshot-Q&A exchange
 * here (text only, no images) so the vision brain's conversations stop being
 * RAM-only amnesia.
 *
 * POST { "source": "vision", "user": string, "assistant": string, "ts"?: ms }
 *   → { ok: true, threadId }
 *
 * Exchanges land on one persistent thread titled "vision". It is an ARCHIVE
 * thread — never run through the CLI — but because it's an ordinary thread,
 * optional memory-ingest can ship it to Brain/gbrain on its cycle and it's
 * visible in the chat UI, all for free. Failures on the app side are
 * fire-and-forget: a dead backend must never break the vision chat itself.
 */

const VISION_THREAD_TITLE = "vision";

function findOrCreateVisionThread() {
  const meta = listThreads().find(
    (m) => m.title === VISION_THREAD_TITLE && m.provider === "claude"
  );
  if (meta) {
    const t = getThread(meta.id);
    if (t) return t;
  }
  // Plan mode + no model: this thread is storage, not a runnable harness.
  const t = createThread("claude", null, "plan");
  t.title = VISION_THREAD_TITLE;
  saveThread(t);
  return t;
}

export async function POST(req: NextRequest) {
  // P8 finding 3: a persisted vision thread is ingested into gbrain/Brain,
  // which the agent later reads — a forged-loopback write is a brain-poison /
  // prompt-injection seed. Require a positive session/control token, not
  // sameOriginOk alone. NOTE: the native Swift vision poster must be rebuilt to
  // attach x-vidi-control-token (it already reads data/control-token, like
  // bin/vidi-act); until then vision archival pauses (fire-and-forget on the app
  // side, so the vision chat itself is unaffected). See PR body.
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  // F4 — consistency with the other state-changing routes: require
  // application/json (or no body). The native app already sends it, so no
  // regression; this forces a would-be cross-origin POST out of the
  // no-preflight "simple request" class.
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const userText = typeof body.user === "string" ? body.user.trim() : "";
  const assistantText =
    typeof body.assistant === "string" ? body.assistant.trim() : "";
  if (!userText || !assistantText) {
    return Response.json(
      { error: "user and assistant texts required" },
      { status: 400 }
    );
  }

  const thread = findOrCreateVisionThread();
  const exchangeTs = typeof body.ts === "number" ? body.ts : Date.now();
  await updateThread(thread.id, (th) => {
    th.messages.push({ role: "user", text: userText, ts: exchangeTs });
    // +1ms keeps the pair ordered even when the app supplies one timestamp.
    th.messages.push({ role: "assistant", text: assistantText, ts: exchangeTs + 1 });
  });

  return Response.json({ ok: true, threadId: thread.id });
}
