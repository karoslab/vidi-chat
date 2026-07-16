import { execFile, spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";
import { workspacePath } from "./workspace.ts";
import { getUserConfig } from "./user-config.ts";
import { redactSecrets } from "./redact.ts";

/**
 * Vidi's brain (gbrain over Brain) — read + note-taking helpers.
 *
 * autoRecall: free embedding search injected into every default voice turn so
 * Vidi recalls without being told to check. Fail-open by design: a slow or
 * broken brain must never delay or break a voice reply.
 *
 * rememberNote: "vidi, remember this: …" writes a note file into Brain;
 * an optional memory-ingest job can commit and sync it into the brain on its next
 * cycle. The route (not the agent) writes, keeping provenance clean.
 */

const GBRAIN_BIN = getUserConfig().gbrainBin;
// gbrain is a `#!/usr/bin/env bun` script; prepend its dir to PATH so a launchd
// service without bun on PATH can still spawn it (found live: recall silently
// never fired). Derived from the configured binary so a relocated gbrain works.
const GBRAIN_BIN_DIR = path.dirname(GBRAIN_BIN);
const BRAIN_NOTES_DIR = workspacePath(getUserConfig().brainDirName, "vidi", "notes");

export function autoRecall(query: string, timeoutMs = 3500): Promise<string | null> {
  // Tiny transcripts ("yes", "stop") carry no recall signal — skip the latency.
  if (query.trim().split(/\s+/).length < 4) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      GBRAIN_BIN,
      ["search", query, "--limit", "4"],
      {
        timeout: timeoutMs,
        env: { ...process.env, PATH: `${GBRAIN_BIN_DIR}:${process.env.PATH || ""}` },
      },
      (error, stdout) => {
        if (error || !stdout?.trim()) return resolve(null);
        const hits = stdout
          .trim()
          .split("\n")
          .filter((line) => line.startsWith("["))
          .slice(0, 4)
          .map((line) => (line.length > 300 ? line.slice(0, 300) + "…" : line));
        resolve(hits.length ? hits.join("\n") : null);
      }
    );
  });
}

export function rememberNote(note: string): string {
  mkdirSync(BRAIN_NOTES_DIR, { recursive: true });
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[:T]/g, "-")
    .slice(0, 19);
  const filePath = path.join(BRAIN_NOTES_DIR, `${stamp}.md`);
  // Content FIRST — search excerpts truncate hard, so a boilerplate header
  // would hide the actual note from auto-recall (found live: Vidi saw the
  // note existed but not what it said, and answered "I don't have anything").
  // Tier-2 (S-redact): this note is written into Brain and gbrain-synced, so
  // scrub secrets before they leave the machine on the brain path.
  const trimmed = redactSecrets(note.trim());
  writeFileSync(
    filePath,
    `# ${trimmed.slice(0, 80)}\n\n${trimmed}\n\n` +
      `*${getUserConfig().displayName} told Vidi to remember this on ${now.toISOString().slice(0, 10)}.*\n`
  );
  // Kick an early ingest so the note reaches gbrain in minutes, not at the
  // next 6h launchd cycle. (The 48h recent buffer covers the gap either way.)
  triggerBrainIngestSoon();
  return filePath;
}

const INGEST_SCRIPT = workspacePath("ops", "tasks", "brain_ingest.py");
// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/last-ingest-trigger.
const ingestTriggerStamp = () => dataPath("last-ingest-trigger");
const INGEST_DEBOUNCE_MS = 15 * 60 * 1000;

/**
 * Fire-and-forget, debounced run of the optional memory-ingest job (idempotent,
 * quiet-by-default). At most one trigger per 15 minutes — the 6h launchd job
 * remains the backstop. Returns true when a run was actually started.
 */
export function triggerBrainIngestSoon(): boolean {
  try {
    const stampAgeMs = Date.now() - statSync(ingestTriggerStamp()).mtimeMs;
    if (stampAgeMs < INGEST_DEBOUNCE_MS) return false;
  } catch {
    /* no stamp yet — first trigger */
  }
  try {
    mkdirSync(path.dirname(ingestTriggerStamp()), { recursive: true });
    writeFileSync(ingestTriggerStamp(), new Date().toISOString());
    const child = spawn("python3", [INGEST_SCRIPT], {
      stdio: "ignore",
      detached: true,
      // brain_ingest shells out to gbrain (a bun script) — same PATH fix as
      // autoRecall above, or the sync step dies silently under launchd.
      env: { ...process.env, PATH: `${GBRAIN_BIN_DIR}:${process.env.PATH || ""}` },
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
