import type { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
// Relative (not "@/") on purpose so this route imports cleanly under plain
// `node --test` (same reason as app/api/phone/ask/route.ts).
import { authorizedByToken, crossOriginResponse, requireWriteAuth, sameOriginOk } from "../../../lib/origin.ts";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  extOf,
  imageExtForMime,
  isAllowedExt,
  isImageExt,
  mimeForRel,
  resolveAttachmentPath,
  uploadsRoot,
} from "../../../lib/attachments.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST (multipart, field "files") — save uploaded attachments under
 * dataDir()/uploads/<batchId>/<uuid><ext> using ONLY server-generated names
 * (the original filename is never used to build a path), and return their
 * metadata. CSRF-guarded like the other write routes: a cross-origin drive-by
 * must not be able to plant files.
 *
 * GET ?rel=<batchId>/<file> — stream a stored file back so a reopened thread
 * can re-render its thumbnails (the client's object URLs are gone by then).
 * The rel is validated against the uploads root; nothing outside it is served.
 */
export async function POST(req: NextRequest) {
  // P8 finding 3 follow-up: this WRITES files to disk under dataDir()/uploads —
  // require a positive session/control token, not sameOriginOk alone. The
  // browser (Chat.tsx fetch("/api/attachments", {method:"POST"})) already
  // carries the session token via the layout fetch-shim. (The GET leg below is
  // unchanged — it already accepts authorizedByToken OR sameOriginOk because a
  // raw <img>/<a> load can't attach a header.)
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;

  const form = await req.formData().catch(() => null);
  if (!form) return Response.json({ error: "multipart form required" }, { status: 400 });

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return Response.json({ error: "no files" }, { status: 400 });
  if (files.length > MAX_ATTACHMENTS)
    return Response.json({ error: `at most ${MAX_ATTACHMENTS} files at once` }, { status: 400 });

  // Validate EVERY file (size + type) before writing ANY — a later rejection
  // must not leave earlier files orphaned on disk with no rel to reach them.
  const plan: { file: File; ext: string; kind: "image" | "file" }[] = [];
  for (const f of files) {
    if (f.size > MAX_ATTACHMENT_BYTES)
      return Response.json({ error: `${f.name} is over 20MB` }, { status: 400 });
    const nameExt = extOf(f.name);
    const mimeExt = imageExtForMime(f.type || "");
    // Accept an image by its allowlisted extension OR by a known raster MIME
    // (covers a pasted screenshot with no filename extension). The on-disk
    // extension is the allowlisted name ext if it has one, else the canonical
    // MIME extension — never the raw filename, which stays metadata-only.
    const safeExt = isAllowedExt(nameExt) ? nameExt : mimeExt || "";
    if (!safeExt)
      return Response.json({ error: `unsupported file type: ${f.name}` }, { status: 400 });
    plan.push({ file: f, ext: safeExt, kind: isImageExt(safeExt) ? "image" : "file" });
  }

  const root = uploadsRoot();
  const batchId = crypto.randomUUID();
  const dir = path.join(root, batchId);
  fs.mkdirSync(dir, { recursive: true });

  const out: { id: string; name: string; kind: "image" | "file"; size: number; rel: string }[] =
    [];
  for (const p of plan) {
    const id = crypto.randomUUID();
    const rel = path.join(batchId, `${id}${p.ext}`);
    fs.writeFileSync(path.join(root, rel), Buffer.from(await p.file.arrayBuffer()));
    out.push({ id, name: p.file.name, kind: p.kind, size: p.file.size, rel });
  }

  return Response.json({ attachments: out });
}

export async function GET(req: NextRequest) {
  // Tier-2 fix-round finding 3: this streams stored upload bytes — screenshots
  // included — so it's gated like the other sensitive reads. Consumed by the
  // browser via a raw <img src>/<a href> (Chat.tsx), which can't attach the
  // x-vidi-session-token header the fetch-shim provides, so accept a valid
  // token OR sameOriginOk (same-origin <img>/<a> loads send no Origin header
  // and pass; a tailscale-serve ts.net Host is rejected by sameOriginOk's H5
  // loopback allowlist). Residual: a raw-TCP forged-loopback-Host request would
  // still pass sameOriginOk alone — same documented gap as agents/events.
  if (!authorizedByToken(req) && !sameOriginOk(req)) return crossOriginResponse();
  const rel = new URL(req.url).searchParams.get("rel") || "";
  const abs = resolveAttachmentPath(rel);
  if (!abs) return new Response("not found", { status: 404 });
  return new Response(fs.readFileSync(abs), {
    headers: {
      "Content-Type": mimeForRel(rel),
      "Cache-Control": "private, max-age=3600",
      // Never let a browser render a served .html/.svg as an active document.
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
