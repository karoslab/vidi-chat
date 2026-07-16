import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Phone access (Journey Stage 6) — the readiness model behind the
 * self-serve phone-browser path.
 *
 * The customer runs everything on their own devices and their own free
 * Tailscale account (their Mac + their phone); they are never on anyone
 * else's private connection. This module only READS local state to answer one question per
 * field: "is the piece that makes the phone work actually true right now?". It
 * never changes the Mac's Tailscale state — turning the connection on is the
 * Vidi Helper's job (vidi-launcher menu.sh), and pairing is the existing
 * one-time-code seam (lib/phone-browser-pairing.ts). Nothing here mints,
 * serves, or logs a secret.
 *
 * Everything shells out to the Tailscale CLI. On a customer Mac that is the
 * app-bundle binary (the App Store / standalone client ships its CLI inside the
 * bundle); a Homebrew / standalone install puts `tailscale` on PATH. TAILSCALE_BIN
 * overrides both for tests (same pattern as GH_BIN in lib/github-connect.ts), so
 * the whole model is exercised against fixtures without touching a real tailnet.
 */

/* -------------------------------------------------------------------------- */
/* CLI resolution + a never-throwing exec helper                              */
/* -------------------------------------------------------------------------- */

/** The Tailscale macOS app ships its CLI inside the bundle at this path. */
export const TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** Resolve the Tailscale CLI: test override first, then the app bundle, then
 *  PATH. Returns the string we hand to execFile; "tailscale" simply ENOENTs on
 *  a Mac without it, which the caller reads as "not installed". */
export function tailscaleBin(): string {
  const override = process.env.TAILSCALE_BIN;
  if (override) return override;
  if (existsSync(TAILSCALE_APP_CLI)) return TAILSCALE_APP_CLI;
  return "tailscale";
}

/** The install's own local port — the loopback port `tailscale serve` forwards
 *  HTTPS to. Mirrors lib/origin.ts's port resolution so the two never drift. */
export function localPort(): string {
  const port = (process.env.PORT || process.env.VIDI_PORT || "4183").trim();
  return port || "4183";
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** set when the binary itself could not be spawned (ENOENT = not installed). */
  spawnError?: NodeJS.ErrnoException;
}

/** Run to completion, capturing output; never rejects. A missing binary comes
 *  back as spawnError so callers branch on data instead of try/catch (same shape
 *  as lib/github-connect.ts's run()). */
function run(args: string[], timeoutMs = 8_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      tailscaleBin(),
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const nodeErr = err as NodeJS.ErrnoException | null;
        if (nodeErr && (nodeErr.code === "ENOENT" || (nodeErr as any).errno === -2)) {
          resolve({ code: 127, stdout: "", stderr: "", spawnError: nodeErr });
          return;
        }
        const code =
          nodeErr && typeof (nodeErr as any).code === "number" ? (nodeErr as any).code : nodeErr ? 1 : 0;
        resolve({ code, stdout: stdout || "", stderr: stderr || "" });
      }
    );
  });
}

/* -------------------------------------------------------------------------- */
/* the readiness model                                                        */
/* -------------------------------------------------------------------------- */

export interface PhoneAccessReadiness {
  /** the Tailscale CLI resolves and answers (the app is set up on this Mac). */
  tailscaleInstalled: boolean;
  /** the customer has signed in (BackendState "Running"). */
  loggedIn: boolean;
  /** this Mac's private connection address, plain (no trailing dot). Null until
   *  signed in. This is the address the customer types on the phone. */
  deviceName: string | null;
  /** `tailscale serve` is forwarding HTTPS to this install's local port. */
  serveActive: boolean;
  /** this running service already trusts that address (VIDI_TRUSTED_HOSTS holds
   *  the device name), so a page served under it ships the session token. */
  trustedHostSet: boolean;
}

/** Strip Tailscale's trailing-dot FQDN form to the plain address we show. */
function cleanDnsName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = String(raw).trim().replace(/\.$/, "");
  return name || null;
}

/** `tailscale status --json` → installed? logged in? this device's name. */
async function readStatus(): Promise<{ installed: boolean; loggedIn: boolean; deviceName: string | null }> {
  const r = await run(["status", "--json"]);
  if (r.spawnError) return { installed: false, loggedIn: false, deviceName: null };
  // A non-zero exit with real output still means the CLI is present (e.g. it
  // prints a "logged out" JSON). Installed := we could spawn it at all.
  let parsed: any = null;
  try {
    parsed = JSON.parse(r.stdout || "null");
  } catch {
    parsed = null;
  }
  if (!parsed) {
    // CLI present but unparseable output — treat as installed, logged out.
    return { installed: true, loggedIn: false, deviceName: null };
  }
  const loggedIn = parsed.BackendState === "Running";
  const deviceName = loggedIn ? cleanDnsName(parsed?.Self?.DNSName) : null;
  return { installed: true, loggedIn, deviceName };
}

/** `tailscale serve status --json` → is HTTPS being forwarded to OUR local
 *  port? We look for a proxy target on this install's loopback port; the ts.net
 *  web key itself uses :443, so matching the local port avoids a false positive. */
async function readServeActive(): Promise<boolean> {
  const r = await run(["serve", "status", "--json"]);
  if (r.spawnError) return false;
  const port = localPort();
  const text = r.stdout || "";
  return text.includes(`127.0.0.1:${port}`) || text.includes(`localhost:${port}`);
}

/** Does this running service already trust `deviceName` as a Host? Reads the
 *  SAME env var lib/origin.ts's allowlist reads, so "trusted" here means exactly
 *  "app/layout.tsx will ship the session token to a page served under it". */
export function trustedHostSetFor(deviceName: string | null): boolean {
  if (!deviceName) return false;
  const trusted = (process.env.VIDI_TRUSTED_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return trusted.includes(deviceName);
}

/**
 * The whole readiness snapshot. Each field is an independent mechanical truth;
 * later fields short-circuit to false when an earlier one isn't met (no device
 * name → nothing can be trusted). Never throws — a broken CLI resolves to the
 * all-false "not set up yet" snapshot.
 */
export async function readiness(): Promise<PhoneAccessReadiness> {
  try {
    const status = await readStatus();
    if (!status.installed) {
      return {
        tailscaleInstalled: false,
        loggedIn: false,
        deviceName: null,
        serveActive: false,
        trustedHostSet: false,
      };
    }
    const serveActive = status.loggedIn ? await readServeActive() : false;
    return {
      tailscaleInstalled: true,
      loggedIn: status.loggedIn,
      deviceName: status.deviceName,
      serveActive,
      trustedHostSet: trustedHostSetFor(status.deviceName),
    };
  } catch {
    return {
      tailscaleInstalled: false,
      loggedIn: false,
      deviceName: null,
      serveActive: false,
      trustedHostSet: false,
    };
  }
}
