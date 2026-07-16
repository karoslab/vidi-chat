import { NextRequest } from "next/server";
import { cancelPending, pendingDescription } from "@/lib/confirm";
import { appendJournal } from "@/lib/journal";
import {
  crossOriginResponse,
  requireWriteAuth,
  sameOriginOk,
} from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST → { cancelled, text }
 *
 * The browser confirm card's "Not now" button. It clears the parked action
 * without running it via the EXISTING cancelPending (lib/confirm.ts) — the same
 * primitive the voice "cancel that" turn uses — and journals a confirm-rejected
 * line for provenance (the confirm-filed line was journaled at park time; the
 * run/cancel is journaled separately).
 *
 * No nonce needed: rejecting only CLEARS the single slot (depth 1), it never
 * runs an action, so there is nothing for the nonce to bind. Gate is still the
 * full write gate — sameOriginOk + requireWriteAuth (positive session/control
 * token, no phone) — because clearing another user's parked action is a
 * state change on the capability surface.
 */
export async function POST(req: NextRequest) {
  if (!sameOriginOk(req)) return crossOriginResponse();
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;

  // Capture the (redacted) description BEFORE cancelling so the journal line has
  // something to say about what was dismissed.
  const description = pendingDescription();
  const { cancelled, text } = cancelPending();

  if (cancelled) {
    try {
      appendJournal({
        ts: Date.now(),
        threadId: "confirm",
        tool: "confirm-rejected",
        summary: description ?? "(nothing described)",
      });
    } catch {
      /* journaling must never break the request */
    }
  }

  return Response.json({ cancelled, text });
}
