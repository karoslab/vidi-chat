import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";

/**
 * Chat attachments — screenshots and files the user hands Vidi for context.
 *
 * How they reach the model: the claude CLI is spawned with cwd = WORK_DIR
 * (the workspace root) and its Read tool is ALWAYS in the allow set (plan + auto), and
 * that Read tool reads images visually + text/PDF as text. So the model never
 * receives file bytes over the wire — the server saves the upload to disk
 * somewhere the CLI is allowed to Read, then the prompt text lists the absolute
 * paths for it to Read. dataDir() = <cwd>/data = the workspace root/vidi-chat/data,
 * which sits inside both WORK_DIR (auto mode --add-dir) and HOME (plan mode
 * --add-dir ~), so files at dataDir()/uploads/… are Readable in BOTH modes.
 *
 * SECURITY INVARIANT: a chat request must NEVER be able to name an arbitrary
 * path (keys.rtf, ~/.ssh/id_rsa) as an "attachment" — the always-allowed Read
 * rule is NOT directory-jailed (see lib/providers/claude.ts), so the model
 * would happily Read whatever path we put in the prompt. Defense: the server
 * only ever resolves a client-supplied `rel` against the uploads root and
 * rejects anything that escapes it or isn't a real file it created. That check
 * lives here, in ONE place, used by the upload route, the chat route, and the
 * tests.
 */

export interface Attachment {
  /** Server-generated uuid. */
  id: string;
  /** Original filename — DISPLAY ONLY, never used to build a filesystem path. */
  name: string;
  kind: "image" | "file";
  size: number;
  /** '<batchId>/<uuid><ext>' relative to the uploads root; re-validated on
   *  every use via resolveAttachmentPath(). */
  rel: string;
}

/** 20 MB per file, 10 files per batch — a personal loopback app, not a CDN. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

// Extension allowlist keyed to what the CLI Read tool can actually use. Images
// are read visually; docs/text are read as text.
export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"]);
export const DOC_EXT = new Set([
  ".pdf", ".txt", ".md", ".csv", ".json", ".log", ".rtf",
  ".yml", ".yaml", ".ts", ".tsx", ".js", ".jsx", ".py", ".sh", ".html", ".css",
]);

/** Absolute, symlink-free-ish root every attachment must live under. */
export function uploadsRoot(): string {
  return path.resolve(dataPath("uploads"));
}

export function extOf(name: string): string {
  return path.extname(name || "").toLowerCase();
}

export function isImageExt(ext: string): boolean {
  return IMAGE_EXT.has(ext);
}

/** True if this extension is one we let through (image or doc). */
export function isAllowedExt(ext: string): boolean {
  return IMAGE_EXT.has(ext) || DOC_EXT.has(ext);
}

export function kindFor(name: string, mime = ""): "image" | "file" {
  return IMAGE_EXT.has(extOf(name)) || !!imageExtForMime(mime) ? "image" : "file";
}

/**
 * Canonical extension for a RASTER image MIME type, or null. Used to give an
 * uploaded image a correct on-disk extension when its filename lacks one (so
 * the thumbnail GET and the CLI Read tool still treat it as an image).
 * Deliberately excludes image/svg+xml — an SVG served inline is a script
 * vector, so SVGs are not accepted as images.
 */
export function imageExtForMime(mime: string): string | null {
  switch ((mime || "").toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/heic":
    case "image/heif":
      return ".heic";
    default:
      return null;
  }
}

/** Content-Type for serving a stored file back (thumbnails on reopen). */
export function mimeForRel(rel: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
  };
  return map[extOf(rel)] || "application/octet-stream";
}

/**
 * THE security chokepoint. Resolve a client-supplied `rel` to an absolute path
 * ONLY if it stays strictly inside the uploads root and points at a real file.
 * Returns the abs path, or null to reject (traversal, absolute path, escaped
 * root, missing file, non-file). Never throws.
 */
export function resolveAttachmentPath(rel: unknown): string | null {
  if (typeof rel !== "string" || !rel) return null;
  const root = uploadsRoot();
  // path.resolve collapses any ../ and, for an absolute `rel`, discards the
  // root entirely — both cases then fail the containment check below.
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null; // does not exist / not accessible
  }
  return abs;
}

/**
 * Best-effort removal of a thread's uploaded files when the thread is deleted —
 * so "delete" actually drops its screenshots and data/uploads doesn't grow
 * forever. Only ever removes batch dirs strictly inside the uploads root
 * (never the root itself); a malformed rel is skipped, not followed out.
 */
export function removeAttachmentFiles(atts: { rel?: string }[] | undefined): void {
  if (!atts || atts.length === 0) return;
  const root = uploadsRoot();
  const batches = new Set<string>();
  for (const a of atts) {
    if (!a || typeof a.rel !== "string" || !a.rel) continue;
    const dir = path.resolve(root, path.dirname(a.rel));
    if (dir === root || !dir.startsWith(root + path.sep)) continue; // stay in-root, spare the root
    batches.add(dir);
  }
  for (const dir of batches) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort — a leftover file is harmless */
    }
  }
}

/**
 * Coerce an untrusted attachment object from a request body into a clean
 * Attachment IFF its `rel` resolves to a real file under the uploads root.
 * Returns { att, abs } or null. This is what the chat route uses before
 * putting any path in front of the model.
 */
export function validateAttachment(
  a: unknown
): { att: Attachment; abs: string } | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const abs = resolveAttachmentPath(o.rel);
  if (!abs) return null;
  return {
    abs,
    att: {
      id: typeof o.id === "string" ? o.id : "",
      name: typeof o.name === "string" && o.name ? o.name : "file",
      kind: o.kind === "image" ? "image" : "file",
      size: Number(o.size) || 0,
      rel: o.rel as string,
    },
  };
}
