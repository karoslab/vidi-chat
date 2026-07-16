import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Version identity for THIS running install.
 *
 * release.json at the repo root is the single source of truth. The committed
 * file says {"version":"dev","sha":"","builtAt":""} — a dev checkout therefore
 * reports a "development build" and the updater stays disabled (unless
 * VIDI_UPDATE_FORCE=1). The packaging/publish pipeline stamps the real values
 * into release.json before it tars the source into the release channel, so a
 * customer install carries a concrete version + git sha it can compare against
 * the worker manifest.
 */
export interface ReleaseInfo {
  version: string;
  sha: string;
  builtAt: string;
}

function releaseJsonPath(): string {
  // Source runs (tests, `next dev`) resolve this module at <root>/lib/release.ts,
  // so the repo root is one dir up. The production bundle inlines this module
  // into a dist chunk, so import.meta.url no longer points at lib/ — fall back
  // to process.cwd(), which the launchd service sets to the repo root
  // (WorkingDirectory=<...>/vidi-chat). First existing candidate wins.
  const candidates: string[] = [];
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(dir, "..", "release.json"));
  } catch {
    /* bundled: import.meta.url may not resolve to a real lib/ path */
  }
  candidates.push(path.join(process.cwd(), "release.json"));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[candidates.length - 1];
}

export function readReleaseInfo(): ReleaseInfo {
  try {
    const j = JSON.parse(fs.readFileSync(releaseJsonPath(), "utf8"));
    return {
      version: typeof j.version === "string" ? j.version : "dev",
      sha: typeof j.sha === "string" ? j.sha : "",
      builtAt: typeof j.builtAt === "string" ? j.builtAt : "",
    };
  } catch {
    // A missing / malformed release.json degrades to a dev build (updater off),
    // never to a crash or a false "up to date".
    return { version: "dev", sha: "", builtAt: "" };
  }
}

/** A dev checkout: no stamped version or no sha. The updater is off here. */
export function isDevBuild(info: ReleaseInfo = readReleaseInfo()): boolean {
  return !info.version || info.version === "dev" || !info.sha;
}

/** Escape hatch to exercise the updater against a real manifest on a dev box. */
export function updateForced(): boolean {
  return process.env.VIDI_UPDATE_FORCE === "1";
}

/** Plain-language version label for the UI. */
export function displayVersion(info: ReleaseInfo = readReleaseInfo()): string {
  return isDevBuild(info) ? "development build" : info.version;
}
