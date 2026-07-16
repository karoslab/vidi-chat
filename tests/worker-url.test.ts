import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * lib/worker-url.ts — WORKER_BASE is resolved once at module load from
 * process.env.VIDI_WORKER_URL (a trailing slash stripped), falling back to a
 * neutral placeholder host. Each scenario needs its own module instance
 * (top-level const, evaluated at import time), so every test imports with a
 * cache-busting query string AFTER setting/clearing the env var.
 */

test("no VIDI_WORKER_URL set: WORKER_BASE falls back to the neutral placeholder", async () => {
  delete process.env.VIDI_WORKER_URL;
  const { WORKER_BASE } = await import("../lib/worker-url.ts?case=default");
  assert.equal(WORKER_BASE, "https://vidi-proxy.example.workers.dev");
});

test("VIDI_WORKER_URL set: WORKER_BASE resolves to it with a trailing slash stripped", async () => {
  process.env.VIDI_WORKER_URL = "https://my-worker.example.com/";
  try {
    const { WORKER_BASE } = await import("../lib/worker-url.ts?case=override");
    assert.equal(WORKER_BASE, "https://my-worker.example.com");
  } finally {
    delete process.env.VIDI_WORKER_URL;
  }
});

test("VIDI_WORKER_URL set without a trailing slash: WORKER_BASE is unchanged", async () => {
  process.env.VIDI_WORKER_URL = "https://another-worker.example.com";
  try {
    const { WORKER_BASE } = await import("../lib/worker-url.ts?case=no-slash");
    assert.equal(WORKER_BASE, "https://another-worker.example.com");
  } finally {
    delete process.env.VIDI_WORKER_URL;
  }
});
