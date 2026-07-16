import { verifyControlToken } from "@/lib/control";
import { pushToPhone } from "@/lib/push";
import type { PushPriority } from "@/lib/push";
import { appendJournal } from "@/lib/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * HTTP push route — the network door onto lib/push.ts's pushToPhone chokepoint.
 * Ops scripts, agents, and the vidi Swift app POST here to reach the owner's phone
 * without embedding the notify.py/ntfy transport themselves; everything funnels
 * through the one transport chain in lib/push.ts.
 *
 * POST { title, body, priority?, tags?, url? } → { ok, delivered }
 *
 * Control-token gated (X-Vidi-Control-Token, constant-time compared in
 * lib/control.ts) rather than same-origin: a phone push is a real-world side
 * effect callable by headless agents/ops that send no Origin, so it needs the
 * cnvsctl-grade token the control plane uses, not the browser CSRF guard.
 *
 * priority maps onto PushPriority ("low"|"default"|"high"|"urgent"); an
 * unknown value falls back to "default" so a producer typo still delivers
 * rather than 400-ing a possibly-important alert. tags/url are accepted for
 * forward-compat with richer transports (ntfy) and folded into the body today
 * so nothing the caller sent is silently dropped.
 */

const PRIORITIES: readonly PushPriority[] = ["low", "default", "high", "urgent"];

/** Trim to a string, or "" for anything non-string — one check per field. */
function asTrimmed(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(req: Request) {
  // Wrong or missing token → 401 before we touch the body or any transport.
  if (!verifyControlToken(req)) {
    return Response.json(
      { error: "invalid or missing control token" },
      { status: 401 }
    );
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const title = asTrimmed(payload.title);
  const body = asTrimmed(payload.body);
  if (!title || !body) {
    return Response.json(
      { error: "title and body are required non-empty strings" },
      { status: 400 }
    );
  }

  // Unknown/absent priority degrades to "default" instead of rejecting — a push
  // is likely worth delivering even if its urgency label was garbled.
  const priority: PushPriority = PRIORITIES.includes(payload.priority)
    ? payload.priority
    : "default";

  // tags/url have no home in the day-0 Discord transport, so fold them into the
  // delivered text rather than dropping them; a real push API can read them off
  // the body later. Kept append-only so the caller's title/body read first.
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((t: unknown) => typeof t === "string" && t.trim())
    : [];
  const url = asTrimmed(payload.url);
  let deliverBody = body;
  if (tags.length) deliverBody += ` [${tags.join(", ")}]`;
  if (url) deliverBody += ` ${url}`;

  // Fail-open is the module contract: pushToPhone never throws, but double-guard
  // so a surprise (bad arg type) can't 500 into an ops caller or voice turn.
  let delivered = false;
  try {
    delivered = await pushToPhone(title, deliverBody, priority);
  } catch (err) {
    console.error("[push] pushToPhone threw:", err);
    delivered = false;
  }

  // Journal every push attempt (delivered or not) so "what did you do" and the
  // audit trail see it. Best-effort — appendJournal swallows its own errors.
  appendJournal({
    ts: Date.now(),
    threadId: "push",
    tool: "Push.toPhone",
    summary: `[${priority}${delivered ? "" : " FAILED"}] ${title}`.slice(0, 200),
  });

  return Response.json({ ok: true, delivered });
}
