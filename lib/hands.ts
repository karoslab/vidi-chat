import fs from "node:fs";
import { dataPath } from "./data-dir.ts";

/**
 * Client for the native Hands control server (the vidi Swift app's
 * HandsControlServer on 127.0.0.1:4184) — GUI actuation: click / type / key /
 * scroll / find-by-title / clickElement. Agents reach this through the control
 * plane (op "hands"), so it is kill-switch-gated and journaled in one place.
 *
 * The shared token is the same value as vidi's VidiConfig.handsControlToken.
 * It lives in data/hands-token (gitignored) or VIDI_HANDS_TOKEN — never in git.
 */

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/hands-token.
const tokenFile = () => dataPath("hands-token");
const PORT = process.env.VIDI_HANDS_PORT || "4184";
const BASE = `http://127.0.0.1:${PORT}`;

function handsToken(): string {
  if (process.env.VIDI_HANDS_TOKEN) return process.env.VIDI_HANDS_TOKEN;
  try {
    return fs.readFileSync(tokenFile(), "utf8").trim();
  } catch {
    return "";
  }
}

export function handsConfigured(): boolean {
  return handsToken().length > 0;
}

async function post(pathname: string, body: unknown): Promise<any> {
  const token = handsToken();
  if (!token) {
    return {
      ok: false,
      error: "Hands not configured — the vidi app isn't running or data/hands-token is missing",
    };
  }
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vidi-hands-token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return await res.json();
  } catch (e: any) {
    return { ok: false, error: `Hands server unreachable on :${PORT} (${e?.message || e})` };
  }
}

export async function handsHealth(): Promise<any> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5_000) });
    return await res.json();
  } catch (e: any) {
    return { ok: false, error: `Hands server unreachable on :${PORT} (${e?.message || e})` };
  }
}

/** Semantic AX-tree snapshot (the preferred, cheap grounding path): a compact
 *  list of on-screen elements with stable ids the brain/agent targets by id. */
export async function handsSnapshot(): Promise<any> {
  const token = handsToken();
  if (!token) return { ok: false, error: "Hands not configured (vidi app not running / no token)" };
  try {
    const res = await fetch(`${BASE}/snapshot`, {
      headers: { "x-vidi-hands-token": token },
      signal: AbortSignal.timeout(10_000),
    });
    return await res.json();
  } catch (e: any) {
    return { ok: false, error: `Hands server unreachable on :${PORT} (${e?.message || e})` };
  }
}

/** Execute one GUI action. `action` is the full /act payload (validated by the
 *  native server), e.g. {action:"clickElement",title:"Send"} or
 *  {action:"type",text:"..."}. */
export async function handsAct(action: Record<string, unknown>): Promise<any> {
  return post("/act", action);
}
