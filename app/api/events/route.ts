import { NextRequest } from "next/server";
import { requireJsonContentType, requireWriteAuth } from "@/lib/origin";
import { spoolEvent } from "@/lib/event-spool";
import type { EventPriority } from "@/lib/events-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * HTTP producer for the proactivity event spine. Anything that can't write the
 * pending/ spool directly posts here: the vidi Swift app emits presence.wake
 * and other signals over URLSession, ops one-liners can curl an event in.
 *
 * POST { source, kind, priority?, title, spoken, detail?, ttlMinutes?, dedupeKey? }
 *   → { ok: true, id }
 *
 * P8 finding 3 follow-up (P7 re-audit): this has NO browser caller (only the
 * Swift app + ops one-liners), so it previously relied on sameOriginOk() alone
 * — a forged-loopback-Host raw-TCP peer could spool an arbitrary
 * high/critical-priority event that makes Vidi speak. requireWriteAuth now
 * requires a positive session/control token. This is a deploy-coupled change:
 * the Swift app and any ops curl script must attach x-vidi-control-token (both
 * already read/hold data/control-token, like bin/vidi-act) — see PR body.
 */

const PRIORITIES: readonly EventPriority[] = ["low", "normal", "high", "critical"];

/** Trim to a string, or "" for anything non-string — callers get one check. */
function asTrimmed(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(req: NextRequest) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const source = asTrimmed(body.source);
  const kind = asTrimmed(body.kind);
  const title = asTrimmed(body.title);
  const spoken = asTrimmed(body.spoken);
  if (!source || !kind || !title || !spoken) {
    return Response.json(
      { error: "source, kind, title and spoken are required non-empty strings" },
      { status: 400 }
    );
  }

  // Default to "normal"; reject an explicitly bad priority rather than silently
  // downgrading it, so a producer typo surfaces instead of mis-prioritizing.
  const rawPriority = body.priority;
  let priority: EventPriority = "normal";
  if (rawPriority !== undefined) {
    if (!PRIORITIES.includes(rawPriority)) {
      return Response.json(
        { error: `priority must be one of ${PRIORITIES.join("|")}` },
        { status: 400 }
      );
    }
    priority = rawPriority;
  }

  // 4h default TTL matches the contract's expectation of short-lived signals;
  // accept a positive number override, ignore anything else.
  const ttlMinutes =
    typeof body.ttlMinutes === "number" && body.ttlMinutes > 0
      ? body.ttlMinutes
      : 240;

  const detail = typeof body.detail === "string" ? body.detail : undefined;
  const dedupeKey =
    typeof body.dedupeKey === "string" && body.dedupeKey.trim()
      ? body.dedupeKey.trim()
      : undefined;

  // Fail-open: a spool write that throws (disk full, perms) must not 500 into a
  // voice turn's producer. Report it but never crash the caller.
  try {
    const event = spoolEvent({
      source,
      kind,
      priority,
      title,
      spoken,
      detail,
      ttlMinutes,
      dedupeKey,
    });
    return Response.json({ ok: true, id: event.id });
  } catch (err) {
    console.error("[events] spool write failed:", err);
    return Response.json({ error: "failed to spool event" }, { status: 500 });
  }
}
