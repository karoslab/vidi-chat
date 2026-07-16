import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { dataDir, dataPath } from "./data-dir.ts";

/**
 * Multi-account Claude registry. Each account maps to a `claude` CLI config
 * dir (CLAUDE_CONFIG_DIR); a null configDir means "don't set the var" — the
 * default account, today's behavior. When multiple accounts are registered,
 * exhausting a limit mid-turn can fail over to the next enabled account.
 *
 * Registry lives in data/accounts.json (gitignored, like all of data/) and is
 * seeded on first read so a fresh install has a default account set. The active id is
 * a one-line data/active-account.json (same JSON-under-data idiom as
 * data/onboarded.json). Registry ORDER is the failover order.
 */

export interface Account {
  id: string;
  label: string;
  /** null = don't set CLAUDE_CONFIG_DIR (default account). May start with ~. */
  configDir: string | null;
  /**
   * true = keep the account in the registry but never spawn on it (rotation
   * and active-resolution skip it). For temporarily unavailable subscriptions
   * that should stay in the registry (labels/order preserved) until restored.
   */
  disabled?: boolean;
}

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset is byte-identical to <cwd>/data/{accounts,active-account}.json.
const registryFile = () => dataPath("accounts.json");
const activeFile = () => dataPath("active-account.json");

// A FRESH install seeds a generic default account — never a handle. The seed
// only runs when data/accounts.json is missing/corrupt (loadAccounts below), so
// an existing install (already holding its own labelled registry) is
// untouched; no migration is needed or wanted.
const SEED: Account[] = [
  { id: "main", label: "Default account", configDir: null },
  { id: "alt", label: "Alt account", configDir: "~/.claude-profiles/alt" },
];

/** Expand a leading ~ to $HOME for use as CLAUDE_CONFIG_DIR. */
export function expandConfigDir(configDir: string | null): string | null {
  if (!configDir) return null;
  if (configDir === "~") return os.homedir();
  if (configDir.startsWith("~/")) return path.join(os.homedir(), configDir.slice(2));
  return configDir;
}

export function loadAccounts(): Account[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile(), "utf8"));
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as Account[];
  } catch {
    /* missing / corrupt — seed below */
  }
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(registryFile(), JSON.stringify(SEED, null, 2));
  } catch {
    /* best-effort seed; fall back to the in-memory copy */
  }
  return SEED;
}

export function getAccount(id: string): Account | undefined {
  return loadAccounts().find((a) => a.id === id);
}

/**
 * Registry entries the provider may actually spawn on. Fails OPEN to the full
 * registry when every entry is disabled — a misconfigured file must degrade to
 * today's behavior (attempt + honest CLI error), never to "no accounts at all".
 */
export function enabledAccounts(): Account[] {
  const accounts = loadAccounts();
  const enabled = accounts.filter((a) => a.disabled !== true);
  return enabled.length > 0 ? enabled : accounts;
}

/** Active account id — defaults to the first enabled registry entry when unset. */
export function getActiveAccountId(): string {
  const accounts = enabledAccounts();
  try {
    const parsed = JSON.parse(fs.readFileSync(activeFile(), "utf8"));
    if (parsed && typeof parsed.id === "string" && accounts.some((a) => a.id === parsed.id)) {
      return parsed.id;
    }
  } catch {
    /* unset / corrupt — fall through to default */
  }
  // Also lands here when the persisted id points at a disabled account.
  return accounts[0]?.id ?? "main";
}

export function getActiveAccount(): Account {
  const id = getActiveAccountId();
  return getAccount(id) ?? enabledAccounts()[0] ?? SEED[0];
}

/**
 * Persist the active account id. Returns false if the id isn't in the
 * registry or is disabled (the 2026-07-05 lesson: never persist a dead
 * account as active).
 */
export function setActiveAccountId(id: string): boolean {
  if (!enabledAccounts().some((a) => a.id === id)) return false;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${activeFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ id }, null, 2));
    fs.renameSync(tmp, activeFile());
    return true;
  } catch {
    return false;
  }
}
