/**
 * The Cloudflare Worker that proxies TTS, feedback, second-opinions, and
 * self-update traffic. Every route/module that needs it imports WORKER_BASE
 * from here instead of hardcoding a hostname, so a self-hosted deploy only
 * needs to set VIDI_WORKER_URL once.
 */
export const WORKER_BASE = (
  process.env.VIDI_WORKER_URL || "https://vidi-proxy.example.workers.dev"
).replace(/\/$/, "");
