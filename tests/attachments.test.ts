import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Attachments — the security-critical piece is that a chat request can NEVER
 * name an arbitrary path (keys.rtf, ~/.ssh) as an "attachment": the model's
 * Read tool is not directory-jailed, so a path that reaches the prompt gets
 * read. resolveAttachmentPath / validateAttachment are the single chokepoint
 * (used by the upload route, the chat route, and here), so they get the bulk
 * of the coverage. The POST/GET route is exercised end-to-end against a temp
 * data dir.
 *
 * P8 finding 3 follow-up: POST now requires requireWriteAuth (a positive
 * session/control token), not sameOriginOk alone — a token-holding caller no
 * longer needs to match Origin at all (a forged custom header can't leave a
 * cross-origin browser page without a CORS preflight the server never grants,
 * so token-possession alone is the CSRF defense now). Every real-save test
 * below attaches the session token the browser fetch-shim would send; the
 * no-token case is asserted separately.
 */

function withTempData<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-att-"));
  process.env.VIDI_DATA_DIR = dir;
  const done = () => delete process.env.VIDI_DATA_DIR;
  try {
    const r = fn(dir);
    if (r instanceof Promise) return r.finally(done);
    done();
    return r;
  } catch (e) {
    done();
    throw e;
  }
}

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

test("resolveAttachmentPath rejects traversal, absolute, and missing refs; accepts a real in-root file", async () => {
  await withTempData(async (dir) => {
    const { resolveAttachmentPath, uploadsRoot } = await import(
      `../lib/attachments.ts?rt=${Date.now()}`
    );
    const root = uploadsRoot();
    fs.mkdirSync(path.join(root, "batch"), { recursive: true });
    const rel = path.join("batch", "file.png");
    fs.writeFileSync(path.join(root, rel), PNG);

    // Accepts a real file inside the uploads root.
    assert.equal(resolveAttachmentPath(rel), path.join(root, rel));

    // Rejects traversal out of the root…
    assert.equal(resolveAttachmentPath("../../../.ssh/id_rsa"), null);
    assert.equal(resolveAttachmentPath("batch/../../secrets"), null);
    // …an absolute path (path.resolve discards the root)…
    assert.equal(resolveAttachmentPath("/Users/example/keys.rtf"), null);
    assert.equal(resolveAttachmentPath(path.join(dir, "outside")), null);
    // …a non-existent in-root file…
    assert.equal(resolveAttachmentPath("batch/nope.png"), null);
    // …and non-strings.
    assert.equal(resolveAttachmentPath(undefined), null);
    assert.equal(resolveAttachmentPath(42 as unknown as string), null);
  });
});

test("validateAttachment returns clean metadata only for a real file", async () => {
  await withTempData(async () => {
    const { validateAttachment, uploadsRoot } = await import(
      `../lib/attachments.ts?rt=${Date.now()}`
    );
    const root = uploadsRoot();
    fs.mkdirSync(path.join(root, "b"), { recursive: true });
    fs.writeFileSync(path.join(root, "b", "x.png"), PNG);

    const ok = validateAttachment({
      id: "id1",
      name: "shot.png",
      kind: "image",
      size: PNG.length,
      rel: "b/x.png",
    });
    assert.ok(ok);
    assert.equal(ok!.att.name, "shot.png");
    assert.equal(ok!.att.kind, "image");
    assert.equal(ok!.abs, path.join(root, "b", "x.png"));

    // A crafted rel is dropped even if the other fields look valid.
    assert.equal(
      validateAttachment({ id: "x", name: "k", kind: "file", size: 1, rel: "../../keys.rtf" }),
      null
    );
  });
});

test("POST saves under uploads with a server name and rejects a tokenless request", async () => {
  await withTempData(async () => {
    const mod = await import(`../app/api/attachments/route.ts?rt=${Date.now()}`);
    const { uploadsRoot } = await import(`../lib/attachments.ts?rt=${Date.now()}`);
    const { getSessionToken } = await import(`../lib/session-token.ts?rt=${Date.now()}`);

    const form = new FormData();
    form.append("files", new File([PNG], "My Screenshot.png", { type: "image/png" }));

    // No token (same-origin or not) is rejected before anything is written —
    // P8 finding 3: requireWriteAuth, not sameOriginOk, gates the write.
    const bad = await mod.POST(
      new Request("http://localhost:4183/api/attachments", {
        method: "POST",
        headers: { host: "localhost:4183", origin: "http://evil.example" },
        body: form,
      }) as any
    );
    assert.equal(bad.status, 401);

    const form2 = new FormData();
    form2.append("files", new File([PNG], "My Screenshot.png", { type: "image/png" }));
    const res = await mod.POST(
      new Request("http://localhost:4183/api/attachments", {
        method: "POST",
        headers: {
          host: "localhost:4183",
          origin: "http://localhost:4183",
          "x-vidi-session-token": getSessionToken(),
        },
        body: form2,
      }) as any
    );
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.attachments.length, 1);
    const a = j.attachments[0];
    assert.equal(a.kind, "image");
    assert.equal(a.name, "My Screenshot.png"); // original name kept as metadata
    // …but the on-disk name is a server uuid, never the raw filename.
    assert.ok(!a.rel.includes("My Screenshot"));
    assert.ok(a.rel.endsWith(".png"));
    assert.ok(fs.existsSync(path.join(uploadsRoot(), a.rel)));
  });
});

test("POST rejects a disallowed extension", async () => {
  await withTempData(async () => {
    const mod = await import(`../app/api/attachments/route.ts?rt=${Date.now()}`);
    const { getSessionToken } = await import(`../lib/session-token.ts?rt=${Date.now()}`);
    const form = new FormData();
    form.append("files", new File([Buffer.from("MZ")], "evil.exe", { type: "application/octet-stream" }));
    const res = await mod.POST(
      new Request("http://localhost:4183/api/attachments", {
        method: "POST",
        headers: {
          host: "localhost:4183",
          origin: "http://localhost:4183",
          "x-vidi-session-token": getSessionToken(),
        },
        body: form,
      }) as any
    );
    assert.equal(res.status, 400);
  });
});

test("POST is atomic: a mid-batch rejection writes NOTHING to disk", async () => {
  await withTempData(async () => {
    const mod = await import(`../app/api/attachments/route.ts?rt=${Date.now()}`);
    const { uploadsRoot } = await import(`../lib/attachments.ts?rt=${Date.now()}`);
    const { getSessionToken } = await import(`../lib/session-token.ts?rt=${Date.now()}`);
    const big = Buffer.alloc(21 * 1024 * 1024, 1); // > 20MB
    const form = new FormData();
    form.append("files", new File([PNG], "ok.png", { type: "image/png" }));
    form.append("files", new File([big], "huge.png", { type: "image/png" }));
    const res = await mod.POST(
      new Request("http://localhost:4183/api/attachments", {
        method: "POST",
        headers: {
          host: "localhost:4183",
          origin: "http://localhost:4183",
          "x-vidi-session-token": getSessionToken(),
        },
        body: form,
      }) as any
    );
    assert.equal(res.status, 400);
    // The valid first file must NOT have been written — no orphaned bytes.
    const root = uploadsRoot();
    const wrote = fs.existsSync(root) ? fs.readdirSync(root).length : 0;
    assert.equal(wrote, 0);
  });
});

test("POST gives a pasted image (no filename extension) a real extension from its MIME", async () => {
  await withTempData(async () => {
    const mod = await import(`../app/api/attachments/route.ts?rt=${Date.now()}`);
    const { getSessionToken } = await import(`../lib/session-token.ts?rt=${Date.now()}`);
    const form = new FormData();
    // A clipboard paste often has a generic/extensionless name.
    form.append("files", new File([PNG], "image", { type: "image/png" }));
    const res = await mod.POST(
      new Request("http://localhost:4183/api/attachments", {
        method: "POST",
        headers: {
          host: "localhost:4183",
          origin: "http://localhost:4183",
          "x-vidi-session-token": getSessionToken(),
        },
        body: form,
      }) as any
    );
    assert.equal(res.status, 200);
    const a = (await res.json()).attachments[0];
    assert.equal(a.kind, "image");
    assert.ok(a.rel.endsWith(".png"), `expected .png, got ${a.rel}`);
  });
});

test("removeAttachmentFiles deletes a thread's batch dir and never escapes the root", async () => {
  await withTempData(async () => {
    const { removeAttachmentFiles, uploadsRoot } = await import(
      `../lib/attachments.ts?rt=${Date.now()}`
    );
    const root = uploadsRoot();
    fs.mkdirSync(path.join(root, "batch"), { recursive: true });
    fs.writeFileSync(path.join(root, "batch", "x.png"), PNG);
    // A sentinel OUTSIDE the root that a malformed rel must never reach.
    const outside = path.join(path.dirname(root), "keep.txt");
    fs.writeFileSync(outside, "keep");

    removeAttachmentFiles([{ rel: "batch/x.png" }, { rel: "../../keep.txt" }, { rel: "" }]);

    assert.equal(fs.existsSync(path.join(root, "batch")), false); // real batch gone
    assert.equal(fs.existsSync(outside), true); // traversal ref ignored
    fs.rmSync(outside, { force: true });
  });
});

test("GET rejects a cross-origin request", async () => {
  await withTempData(async () => {
    const mod = await import(`../app/api/attachments/route.ts?rt=${Date.now()}`);
    const res = await mod.GET(
      new Request("http://localhost:4183/api/attachments?rel=x/y.png", {
        headers: { host: "localhost:4183", origin: "http://evil.example" },
      }) as any
    );
    assert.equal(res.status, 403);
  });
});

test("GET serves an in-root file and 404s a traversal rel", async () => {
  await withTempData(async () => {
    const mod = await import(`../app/api/attachments/route.ts?rt=${Date.now()}`);
    const { uploadsRoot } = await import(`../lib/attachments.ts?rt=${Date.now()}`);
    const root = uploadsRoot();
    fs.mkdirSync(path.join(root, "g"), { recursive: true });
    fs.writeFileSync(path.join(root, "g", "y.png"), PNG);

    const ok = await mod.GET(
      new Request(`http://localhost:4183/api/attachments?rel=${encodeURIComponent("g/y.png")}`, {
        headers: { host: "localhost:4183" },
      }) as any
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("Content-Type"), "image/png");

    const bad = await mod.GET(
      new Request(
        `http://localhost:4183/api/attachments?rel=${encodeURIComponent("../../../etc/hosts")}`,
        { headers: { host: "localhost:4183" } }
      ) as any
    );
    assert.equal(bad.status, 404);
  });
});
