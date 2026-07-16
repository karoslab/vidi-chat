import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EVENTS_SPOOL_PENDING, type VidiEvent } from "./events-types.ts";

/**
 * The shared TypeScript producer-side writer for the proactivity event spine.
 *
 * Everything without file access of its own (the /api/events route, and
 * through it the Swift app posting presence.wake) funnels here. Ops Python
 * jobs write the same Maildir-style pending/ spool by hand; the broker
 * (lib/events.ts) is the sole reader and mover. Keeping this dependency-free
 * (node fs/path/crypto + the frozen contract only) means the route and any
 * future TS producer share one, tested, atomic writer instead of each
 * re-implementing the tmp+rename dance and drifting.
 */

/** Fill the two producer-generated fields the contract leaves to us. */
function completeEvent(
  partial: Omit<VidiEvent, "id" | "ts"> & { id?: string; ts?: number }
): VidiEvent {
  // ts first so a caller-omitted id can embed the same ts we settled on.
  const ts = typeof partial.ts === "number" ? partial.ts : Date.now();
  const id =
    typeof partial.id === "string" && partial.id.length > 0
      ? partial.id
      : `evt-${ts}-${crypto.randomBytes(4).toString("hex")}`;
  return { ...partial, id, ts };
}

/**
 * Spool one VidiEvent into the pending/ dir as a single JSON file, atomically.
 *
 * @param partial  the event minus id/ts (either may be supplied to override).
 * @param dir      spool directory; defaults to the absolute EVENTS_SPOOL_PENDING.
 *                 Only tests pass this — EVENTS_SPOOL_PENDING is an absolute
 *                 path, so chdir alone cannot redirect the write into a temp dir.
 * @returns        the completed event (with the id/ts that were written).
 */
export function spoolEvent(
  partial: Omit<VidiEvent, "id" | "ts"> & { id?: string; ts?: number },
  dir: string = EVENTS_SPOOL_PENDING
): VidiEvent {
  const event = completeEvent(partial);
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `${event.id}.json`);
  // Write-temp-then-rename so the broker never reads a torn half-written file:
  // rename is atomic within a filesystem, and the .tmp stem is not *.json so a
  // scan mid-write ignores it. Same discipline as lib/store.ts.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(event));
  fs.renameSync(tmp, file);

  return event;
}
