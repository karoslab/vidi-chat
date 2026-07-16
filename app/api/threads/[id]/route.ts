import { NextRequest } from "next/server";
import { deleteThread, getThread, isTurnRunning, updateThread } from "@/lib/store";
import { getLive } from "@/lib/live-buffer";
import { normalizeEffort, normalizeMode } from "@/lib/models";
import { isModelValidForProvider } from "@/lib/thread-settings";
import { requireReadAuth, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const thread = getThread(id);
  if (!thread) return Response.json({ error: "not found" }, { status: 404 });
  const running = isTurnRunning(id);
  // Live partial: the text streamed so far by an in-flight turn (incl. the
  // failover switch notice) so the reconnect poll can replay the in-progress
  // bubble instead of only a static "still working" line. Only meaningful
  // while a turn runs; a stale buffer never outlives its turn (cleared in the
  // provider's finally).
  const live = running ? getLive(id) : null;
  return Response.json({
    thread: {
      ...thread,
      running,
      live: live ? { text: live.text, updatedAt: live.updatedAt } : null,
    },
  });
}

/**
 * PATCH { mode?, model?, effort? } — flip a thread's harness settings.
 * mode: "plan" | "auto" (legacy "chat"/"act" accepted);
 * effort: low|medium|high|ultra.
 * model: validated against the thread's OWN provider's model list (see
 * lib/thread-settings.isModelValidForProvider — a static whitelist here used to
 * 400 every grok/codex model id, so per-thread model switching only worked for
 * Claude). "fable" is still accepted as a legacy Claude pin.
 */

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // P8 finding 3 follow-up: flipping a thread's mode to "auto"/act settings is
  // a capability grant, not just metadata — same requireWriteAuth gate as the
  // GET's requireReadAuth. Browser (Chat.tsx fetch PATCH) already carries the
  // session token via the layout fetch-shim.
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* fallthrough to validation */
  }
  const hasMode = body.mode !== undefined;
  const hasModel = body.model !== undefined;
  const hasEffort = body.effort !== undefined;
  const hasTitle = body.title !== undefined;
  if (!hasMode && !hasModel && !hasEffort && !hasTitle) {
    return Response.json(
      { error: "nothing to patch. Send mode, model, effort, and/or title" },
      { status: 400 }
    );
  }
  if (hasModel) {
    // Validate the model against the thread's actual provider, not a static set.
    const existing = getThread(id);
    if (!existing) return Response.json({ error: "not found" }, { status: 404 });
    if (!isModelValidForProvider(existing.provider, body.model)) {
      return Response.json(
        { error: `unknown model for provider ${existing.provider}: ${body.model}` },
        { status: 400 }
      );
    }
  }
  if (hasTitle) {
    const t = typeof body.title === "string" ? body.title.trim() : "";
    if (!t) return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
    if (t.length > 80) return Response.json({ error: "title exceeds 80 characters" }, { status: 400 });
  }
  // Atomic under the thread lock — a bare read→await→save here clobbered
  // concurrent turn writes (the exact lost-update Phase 0 removed).
  const thread = await updateThread(id, (th) => {
    if (hasMode) th.mode = normalizeMode(body.mode);
    if (hasModel) th.model = body.model;
    if (hasEffort) th.effort = normalizeEffort(body.effort);
    if (hasTitle) th.title = (body.title as string).trim();
  });
  if (!thread) return Response.json({ error: "not found" }, { status: 404 });
  const { messages, ...meta } = thread;
  return Response.json({ thread: meta });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // P8 finding 3 follow-up: deleting a thread is an irreversible write.
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  return Response.json({ ok: deleteThread(id) });
}
