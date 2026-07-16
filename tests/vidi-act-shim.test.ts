import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * W3 vidi-act shim: the agent's action chokepoint. We spawn the real shim as a
 * subprocess (the way act mode's Bash allowlist runs it) against two stub
 * servers on ephemeral ports, and assert the ONE declarative verb table routes
 * correctly:
 *   - safe verb        → direct POST to the Hands /act stub, exit 0
 *   - confirm verb     → POST /api/confirm/request, prints the exact PENDING
 *                        line, exit nonzero
 *   - unclassified verb→ default-DENY → filed as confirm (never silent)
 *   - --from-tool-output on a SAFE verb → injection rule forces confirm
 *   - Hands token is read from disk, never argv
 */

const SHIM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "vidi-act"
);

interface Captured {
  path: string;
  body: any;
  headers: http.IncomingHttpHeaders;
}

/** Start a stub HTTP server that records requests and replies with `reply`. */
function startStub(
  reply: (req: Captured) => { status?: number; json: any }
): Promise<{ port: number; calls: Captured[]; close: () => Promise<void> }> {
  const calls: Captured[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const captured: Captured = { path: req.url || "", body, headers: req.headers };
      calls.push(captured);
      const r = reply(captured);
      res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({
        port,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function runShim(
  args: string[],
  env: Record<string, string>
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SHIM, ...args],
      { env: { ...process.env, ...env } },
      (err: any, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      }
    );
  });
}

test("safe verb (timer) → direct Hands /act POST, exit 0, token from env", async () => {
  const hands = await startStub(() => ({ json: { ok: true, say: "Timer set." } }));
  try {
    const res = await runShim(["timer", '{"minutes":5}'], {
      VIDI_HANDS_PORT: String(hands.port),
      VIDI_HANDS_TOKEN: "test-hands-token",
    });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Timer set\./);
    assert.equal(hands.calls.length, 1);
    assert.equal(hands.calls[0].path, "/act");
    // timer rides under action:"system", verb:"timer".
    assert.equal(hands.calls[0].body.action, "system");
    assert.equal(hands.calls[0].body.verb, "timer");
    assert.equal(hands.calls[0].body.minutes, 5);
    // Token travels in the header (from disk/env), not the payload.
    assert.equal(hands.calls[0].headers["x-vidi-hands-token"], "test-hands-token");
  } finally {
    await hands.close();
  }
});

test("confirm verb (email-send) → files a confirm, exact PENDING line, nonzero exit", async () => {
  const app = await startStub(() => ({ json: { pendingId: "pending-x", description: "d" } }));
  try {
    const res = await runShim(
      ["email-send", '{"to":"mom@x.com","subject":"hi","body":"late"}'],
      { VIDI_PORT: String(app.port) }
    );
    assert.notEqual(res.code, 0, "confirm-tier must exit nonzero");
    assert.match(
      res.stdout,
      /^PENDING CONFIRMATION: .+ — tell the owner and end your turn\.$/m
    );
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].path, "/api/confirm/request");
    assert.equal(app.calls[0].body.kind, "gws-email");
    assert.equal(app.calls[0].body.payload.to, "mom@x.com");
    // Native/curl-class: no Origin header → passes the same-origin gate.
    assert.equal(app.calls[0].headers.origin, undefined);
  } finally {
    await app.close();
  }
});

test("calendar-create: 'title' aliases to 'summary' in payload AND description", async () => {
  const app = await startStub(() => ({ json: { pendingId: "pending-x", description: "d" } }));
  try {
    const res = await runShim(
      [
        "calendar-create",
        '{"title":"Vidi write test","start":"2026-07-10T17:00:00","end":"2026-07-10T18:00:00"}',
      ],
      { VIDI_PORT: String(app.port) }
    );
    assert.notEqual(res.code, 0, "confirm-tier must exit nonzero");
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].body.kind, "gws-calendar");
    // The live 2026-07-09 failure: title-only args parked as "an event" with an
    // empty summary the executor then threw on. Both must carry the real name.
    assert.equal(app.calls[0].body.payload.summary, "Vidi write test");
    assert.match(app.calls[0].body.description, /"Vidi write test"/);
  } finally {
    await app.close();
  }
});

test("unclassified verb → default-DENY → filed as confirm (never silent)", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(["nuke-everything", "{}"], {
      VIDI_PORT: String(app.port),
    });
    assert.notEqual(res.code, 0);
    assert.match(res.stdout, /PENDING CONFIRMATION:/);
    assert.equal(app.calls.length, 1, "an unknown verb must be FILED, not run");
    assert.equal(app.calls[0].body.kind, "hands");
  } finally {
    await app.close();
  }
});

test("injection rule: --from-tool-output forces a SAFE verb to confirm", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  const hands = await startStub(() => ({ json: { ok: true, say: "nope" } }));
  try {
    const res = await runShim(["timer", '{"minutes":5}', "--from-tool-output"], {
      VIDI_PORT: String(app.port),
      VIDI_HANDS_PORT: String(hands.port),
      VIDI_HANDS_TOKEN: "t",
    });
    assert.notEqual(res.code, 0, "tool-output-derived action must not run silently");
    assert.match(res.stdout, /PENDING CONFIRMATION:/);
    // It went to the confirm queue, NOT the Hands server.
    assert.equal(app.calls.length, 1);
    assert.equal(hands.calls.length, 0);
    assert.match(app.calls[0].body.description, /from something you read/);
  } finally {
    await app.close();
    await hands.close();
  }
});

test("refusal format: unknown-args JSON → nonzero exit, message on stderr", async () => {
  const res = await runShim(["timer", "not-json"], {});
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /Args must be JSON/);
});

// --- Batch A item 1: email-send arg aliases + recipient validation -----------

test("email-send: aliases recipient→to and message→body in the filed payload", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(
      ["email-send", '{"recipient":"mom@x.com","subject":"hi","message":"late"}'],
      { VIDI_PORT: String(app.port) }
    );
    assert.notEqual(res.code, 0, "confirm-tier must exit nonzero");
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].body.kind, "gws-email");
    // recipient→to and message→body — the model's natural keys must not degrade
    // to an empty recipient (throw) or an empty body (a real empty email sent).
    assert.equal(app.calls[0].body.payload.to, "mom@x.com");
    assert.equal(app.calls[0].body.payload.body, "late");
    assert.match(app.calls[0].body.description, /mom@x\.com/);
  } finally {
    await app.close();
  }
});

test("email-send: a bare non-@ recipient is refused at PARK time, nothing filed", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(
      ["email-send", '{"to":"mom","subject":"hi","body":"x"}'],
      { VIDI_PORT: String(app.port) }
    );
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /email address/i);
    assert.equal(app.calls.length, 0, "an @-less recipient must never reach the confirm queue");
  } finally {
    await app.close();
  }
});

// --- Batch A item 2: cc surfaced in the parked description + payload ----------

test("email-send: cc is carried into the payload and shown in the description", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(
      ["email-send", '{"to":"a@x.com","cc":"b@x.com","subject":"hi","body":"x"}'],
      { VIDI_PORT: String(app.port) }
    );
    assert.notEqual(res.code, 0);
    assert.equal(app.calls[0].body.payload.cc, "b@x.com");
    // The human hears the cc so the approved email matches the sent email.
    assert.match(app.calls[0].body.description, /cc b@x\.com/);
  } finally {
    await app.close();
  }
});

// --- Batch A item 5: write-file content alias, empty-string, missing refusal --

test("write-file: aliases text→content in the filed payload", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(
      ["write-file", '{"path":"/Users/nobody/Documents/x.txt","text":"hello"}'],
      { VIDI_PORT: String(app.port) }
    );
    assert.notEqual(res.code, 0);
    assert.equal(app.calls[0].body.kind, "write-file");
    // Without the alias this parked with no content and wrote a zero-byte file.
    assert.equal(app.calls[0].body.payload.content, "hello");
  } finally {
    await app.close();
  }
});

test("write-file: an explicit empty-string content is allowed (deliberate empty file)", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(
      ["write-file", '{"path":"/Users/nobody/Documents/x.txt","content":""}'],
      { VIDI_PORT: String(app.port) }
    );
    assert.notEqual(res.code, 0, "an out-of-jail write still parks a confirm");
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].body.payload.content, "");
  } finally {
    await app.close();
  }
});

test("write-file: content missing ENTIRELY is refused at PARK time, nothing filed", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(
      ["write-file", '{"path":"/Users/nobody/Documents/x.txt"}'],
      { VIDI_PORT: String(app.port) }
    );
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /contents/i);
    assert.equal(app.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("write-file: a ~/Desktop target short-circuits to the Write tool, no confirm filed", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(
      ["write-file", '{"path":"~/Desktop/vidi-note.txt","content":"hi"}'],
      { VIDI_PORT: String(app.port), HOME: "/Users/nobody" }
    );
    // Tilde now expands, so the allowed-dir short-circuit fires (exit 0, no park).
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /use your Write tool/i);
    assert.equal(app.calls.length, 0);
  } finally {
    await app.close();
  }
});

// --- Batch A item 8: payload shapes (system verbs + verb-override guard) ------

test("dnd (newly-mapped system verb) dispatches as {action:system, verb:dnd}", async () => {
  const hands = await startStub(() => ({ json: { ok: true, say: "Do not disturb is on." } }));
  try {
    const res = await runShim(["dnd", '{"on":true}'], {
      VIDI_HANDS_PORT: String(hands.port),
      VIDI_HANDS_TOKEN: "t",
    });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(hands.calls.length, 1);
    assert.equal(hands.calls[0].body.action, "system");
    assert.equal(hands.calls[0].body.verb, "dnd");
    assert.equal(hands.calls[0].body.on, true);
  } finally {
    await hands.close();
  }
});

test("default-deny: an args.action key can NOT override the approved verb", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(["bogus", '{"action":"type","text":"x"}'], {
      VIDI_PORT: String(app.port),
    });
    assert.notEqual(res.code, 0);
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].body.kind, "hands");
    // The human approves "bogus"; a smuggled action:"type" must not fire instead.
    assert.equal(app.calls[0].body.payload.action, "bogus");
  } finally {
    await app.close();
  }
});

test("injection-forced safe verb files the SAME system-wrapped shape, not a flat one", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(["timer", '{"minutes":5}', "--from-tool-output"], {
      VIDI_PORT: String(app.port),
    });
    assert.notEqual(res.code, 0);
    // A confirm-forced timer must ride {action:system,verb:timer} like the safe
    // path — the flat {action:"timer"} used to 400 after approval.
    assert.equal(app.calls[0].body.payload.action, "system");
    assert.equal(app.calls[0].body.payload.verb, "timer");
    assert.equal(app.calls[0].body.payload.minutes, 5);
  } finally {
    await app.close();
  }
});

// --- Batch A item 9: send-message refuses at park time, never files ----------

test("send-message: refuses at PARK time (speakable), never parks a confirm", async () => {
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  const hands = await startStub(() => ({ json: { ok: true } }));
  try {
    const res = await runShim(["send-message", '{"to":"Maya","text":"hi"}'], {
      VIDI_PORT: String(app.port),
      VIDI_HANDS_PORT: String(hands.port),
      VIDI_HANDS_TOKEN: "t",
    });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /can't send messages yet/i);
    assert.equal(app.calls.length, 0, "send-message must not file a doomed confirm");
    assert.equal(hands.calls.length, 0);
  } finally {
    await app.close();
    await hands.close();
  }
});

// --- Batch A item 11: read verbs return their payload, not "Done." -----------

test("context (read verb): prints the response data, not the content-free 'Done.'", async () => {
  const hands = await startStub(() => ({
    json: {
      ok: true,
      now: { frontmostApp: "Xcode", windowTitle: "vidi" },
      timelineSummary: "coding for 20m",
      generatedAt: 123,
    },
  }));
  try {
    const res = await runShim(["context", "{}"], {
      VIDI_HANDS_PORT: String(hands.port),
      VIDI_HANDS_TOKEN: "t",
    });
    assert.equal(res.code, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /^Done\.$/m);
    // The agent must actually receive the screen context it asked for.
    assert.match(res.stdout, /timelineSummary/);
    assert.match(res.stdout, /Xcode/);
  } finally {
    await hands.close();
  }
});

// --- QA follow-up (post-#47 review): openUrl URL tiering ---------------------
//
// openUrl was safe-tier (no confirm) via BOTH the direct `openUrl` verb AND the
// pre-existing generic `system` verb ({verb:"openUrl"}) — the injection rule
// can't catch a prompt-injected model driving either, since it relies on the
// model self-declaring --from-tool-output. A local-console URL (this machine's
// own http(s) server) stays safe; anything else parks a confirm with the FULL
// url spoken so the owner sees exactly what would open.

test("openUrl (direct verb): a localhost URL stays safe-tier, no confirm", async () => {
  const hands = await startStub(() => ({ json: { ok: true, say: "Opening it." } }));
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(["openUrl", '{"url":"http://localhost:3100/"}'], {
      VIDI_HANDS_PORT: String(hands.port),
      VIDI_HANDS_TOKEN: "t",
      VIDI_PORT: String(app.port),
    });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(hands.calls.length, 1, "a local-console URL must run direct");
    assert.equal(hands.calls[0].body.action, "system");
    assert.equal(hands.calls[0].body.verb, "openUrl");
    assert.equal(app.calls.length, 0);
  } finally {
    await hands.close();
    await app.close();
  }
});

test("openUrl (direct verb): an external https host parks a confirm with the full URL spoken", async () => {
  const hands = await startStub(() => ({ json: { ok: true } }));
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(
      ["openUrl", '{"url":"https://evil.example/?d=exfil"}'],
      {
        VIDI_HANDS_PORT: String(hands.port),
        VIDI_HANDS_TOKEN: "t",
        VIDI_PORT: String(app.port),
      }
    );
    assert.notEqual(res.code, 0, "an external URL must NOT run silently");
    assert.equal(hands.calls.length, 0, "must not have fired before the human said yes");
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].body.kind, "hands");
    // The human must see the FULL destination, not a summary.
    assert.match(app.calls[0].body.description, /https:\/\/evil\.example\/\?d=exfil/);
    assert.equal(app.calls[0].body.payload.url, "https://evil.example/?d=exfil");
  } finally {
    await hands.close();
    await app.close();
  }
});

test("openUrl (direct verb): file:// is confirm-tier, not safe", async () => {
  const hands = await startStub(() => ({ json: { ok: true } }));
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    const res = await runShim(["openUrl", '{"url":"file:///etc/hosts"}'], {
      VIDI_HANDS_PORT: String(hands.port),
      VIDI_HANDS_TOKEN: "t",
      VIDI_PORT: String(app.port),
    });
    assert.notEqual(res.code, 0);
    assert.equal(hands.calls.length, 0);
    assert.equal(app.calls.length, 1);
    assert.match(app.calls[0].body.description, /file:\/\/\/etc\/hosts/);
  } finally {
    await hands.close();
    await app.close();
  }
});

test("system verb with {verb:'openUrl'} (the escape-hatch path): same tiering applies", async () => {
  const hands = await startStub(() => ({ json: { ok: true, say: "Opening it." } }));
  const app = await startStub(() => ({ json: { pendingId: "p", description: "d" } }));
  try {
    // Local console → safe, no confirm, still runs direct.
    const safeRes = await runShim(
      ["system", '{"verb":"openUrl","url":"http://127.0.0.1:4183/"}'],
      {
        VIDI_HANDS_PORT: String(hands.port),
        VIDI_HANDS_TOKEN: "t",
        VIDI_PORT: String(app.port),
      }
    );
    assert.equal(safeRes.code, 0, safeRes.stderr);
    assert.equal(hands.calls.length, 1);
    assert.equal(app.calls.length, 0);

    // External host through the SAME generic verb → must still park, not run —
    // this is the exact undocumented "escape hatch" the audit flagged (finding
    // 7) that bypassed the openUrl verb's own gating before this fix.
    const riskyRes = await runShim(
      ["system", '{"verb":"openUrl","url":"https://evil.example/steal"}'],
      {
        VIDI_HANDS_PORT: String(hands.port),
        VIDI_HANDS_TOKEN: "t",
        VIDI_PORT: String(app.port),
      }
    );
    assert.notEqual(riskyRes.code, 0, "the system-verb escape hatch must not bypass URL tiering");
    assert.equal(hands.calls.length, 1, "still just the one earlier safe call — nothing new fired");
    assert.equal(app.calls.length, 1);
    assert.match(app.calls[0].body.description, /https:\/\/evil\.example\/steal/);
  } finally {
    await hands.close();
    await app.close();
  }
});
