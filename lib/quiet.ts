import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";

/**
 * Manual "quiet mode" override for the politeness engine — the guaranteed
 * human-in-the-loop kill for unprompted speech. macOS Focus/DND detection is
 * unreliable (the app can't always read Focus state), so this file is the one
 * signal the owner can toggle by voice that the broker will always trust: it ORs
 * straight into PolicyInputs.dndOrQuiet, which suppresses proactive delivery.
 *
 * Deliberately dumb and persistent: a single JSON file that survives restarts,
 * read fail-open (any error → NOT quiet, so a corrupt/missing file can never
 * silence Vidi indefinitely — the safe failure is speaking, not going mute).
 */

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/quiet.json.
const quietFile = () => dataPath("quiet.json");

interface QuietState {
  quiet: boolean;
  /** Epoch ms the current state was set — for logs / "quiet since" phrasing. */
  since: number;
}

/**
 * Is quiet mode on? Fail-open to false: a missing file (never toggled) or an
 * unreadable/corrupt one must leave Vidi able to speak, never permanently mute.
 */
export function isQuiet(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(quietFile(), "utf8")) as QuietState;
    return raw.quiet === true;
  } catch {
    return false;
  }
}

/** Persist the toggle. Never throws — a failed write must not break a voice turn. */
export function setQuiet(on: boolean): void {
  try {
    fs.mkdirSync(path.dirname(quietFile()), { recursive: true });
    const state: QuietState = { quiet: on, since: Date.now() };
    fs.writeFileSync(quietFile(), JSON.stringify(state) + "\n");
  } catch {
    /* fail-open: if we can't persist, the broker keeps its last known state */
  }
}
