import { execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { listAgents } from "./agents/manager.ts";
import { listGoals } from "./goals.ts";
import { readJournal } from "./journal.ts";
import { WORKSPACE_ROOT } from "./workspace.ts";
import { getUserConfig } from "./user-config.ts";

/**
 * Standing Report — "vidi, good morning / what's broken".
 *
 * Gathers the ops picture DETERMINISTICALLY (no LLM, no cost): local service
 * health, deploy verdicts, today's briefing, the latest nightshift run,
 * and the agent fleet. The service portfolio and the deploy-verdict / nightshift
 * paths are install-specific and come from VIDI_OPS_CONFIG (see below). The
 * voice route hands the result to a normal act turn as a rewritten prompt, so
 * the SPOKEN brief is composed by Claude on the subscription — grounded in this
 * data, not vibes.
 *
 * Every probe fails soft: a dead service is a FINDING ("<name> is down"),
 * never an exception.
 */

/**
 * The ops portfolio (which services to probe, and where the deploy-verdict DB /
 * NightShift state live) is INSTALL-SPECIFIC, so it is not hardcoded in source —
 * a fresh checkout ships with an empty portfolio and reports it honestly. Point
 * VIDI_OPS_CONFIG at a JSON file to enable the ops probes:
 *
 *   {
 *     "services":      [{ "name": "my-service", "url": "http://localhost:3000/" }],
 *     "deployVerdictsDb": "path/to/verdicts.db",
 *     "nightshiftDir": "nightshift/.nightshift"
 *   }
 *
 * Path fields are absolute-or-workspace-relative (a relative value is joined
 * under WORKSPACE_ROOT). See config/ops-config.example.json for a ready-to-use
 * template. Missing/unset/corrupt config is fail-soft: the report degrades to
 * "no services configured" / "not configured", never an exception.
 */
export interface OpsService {
  name: string;
  url: string;
}
export interface OpsConfig {
  services: OpsService[];
  deployVerdictsDb: string | null;
  nightshiftDir: string | null;
}

const EMPTY_OPS_CONFIG: OpsConfig = { services: [], deployVerdictsDb: null, nightshiftDir: null };

/** A configured path is used as-is when absolute, else resolved under the
 *  workspace root — so the example config stays machine-independent. */
function resolveOpsPath(value: string): string {
  return path.isAbsolute(value) ? value : path.join(WORKSPACE_ROOT, value);
}

/** Read + validate VIDI_OPS_CONFIG. Any problem (unset, unreadable, corrupt,
 *  wrong shape) yields the empty portfolio rather than throwing — the report
 *  must stay speakable even with no ops config present. */
export function loadOpsConfig(): OpsConfig {
  const file = process.env.VIDI_OPS_CONFIG;
  if (!file || !file.trim()) return EMPTY_OPS_CONFIG;
  try {
    const parsed = JSON.parse(readFileSync(file.trim(), "utf8"));
    if (!parsed || typeof parsed !== "object") return EMPTY_OPS_CONFIG;
    const services: OpsService[] = Array.isArray(parsed.services)
      ? parsed.services
          .filter(
            (s: unknown): s is OpsService =>
              !!s &&
              typeof (s as OpsService).name === "string" &&
              typeof (s as OpsService).url === "string"
          )
          .map((s: OpsService) => ({ name: s.name, url: s.url }))
      : [];
    const dgField = parsed.deployVerdictsDb ?? parsed.deployGuardDb; // legacy key accepted
    const dgRaw = typeof dgField === "string" ? dgField.trim() : "";
    const nsRaw = typeof parsed.nightshiftDir === "string" ? parsed.nightshiftDir.trim() : "";
    return {
      services,
      deployVerdictsDb: dgRaw ? resolveOpsPath(dgRaw) : null,
      nightshiftDir: nsRaw ? resolveOpsPath(nsRaw) : null,
    };
  } catch {
    return EMPTY_OPS_CONFIG; // missing / corrupt — honest empty, never throw
  }
}

/** The BRIEFINGS dir under the (config-driven) brain root. Resolved at call time
 *  so a just-changed brainDirName / workspace root is reflected. */
function briefingsDir(): string {
  return path.join(WORKSPACE_ROOT, getUserConfig().brainDirName, "BRIEFINGS");
}

async function probeService(name: string, url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return `${name}: ${res.ok ? "up" : `HTTP ${res.status}`}`;
  } catch {
    return `${name}: DOWN`;
  }
}

function deployVerdicts(dbPath: string | null): Promise<string> {
  // Not configured on this install → an honest line, not a probe.
  if (!dbPath) return Promise.resolve("deploy verdicts: not configured");
  // The sqlite3 CLI instead of node:sqlite — Next's bundler rewrites require()
  // and breaks the builtin inside the server runtime (found live by the very
  // first standing report). Read-only file URI so we can never lock DG's DB.
  return new Promise((resolve) => {
    execFile(
      "sqlite3",
      [
        `file:${dbPath}?mode=ro`,
        `SELECT p.slug || ': ' || COALESCE(
           (SELECT verdict FROM runs WHERE project_id = p.id
             ORDER BY started_at DESC LIMIT 1), 'never run')
         FROM projects p ORDER BY p.slug;`,
      ],
      { timeout: 3000 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(`deploy verdicts: unreadable (${error?.message?.slice(0, 80) || "empty"})`);
        } else {
          resolve(stdout.trim().split("\n").join(", "));
        }
      }
    );
  });
}

function todaysBriefing(): string {
  try {
    const dir = briefingsDir();
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    const newest = files[files.length - 1];
    if (!newest) return "(no briefings)";
    const text = readFileSync(path.join(dir, newest), "utf8");
    return `${newest}:\n${text.split("\n").slice(0, 40).join("\n")}`;
  } catch {
    return "(briefings unreadable)";
  }
}

function latestNightShift(nightshiftDir: string | null): string {
  if (!nightshiftDir) return "(NightShift not configured)";
  try {
    const pointer = path.join(nightshiftDir, "latest.json");
    if (!existsSync(pointer)) return "(no NightShift runs)";
    const latest = JSON.parse(readFileSync(pointer, "utf8"));
    const runId = latest.runId || latest.id || "";
    const report = path.join(nightshiftDir, runId, "report.md");
    if (!existsSync(report)) return `latest run ${runId} (no report)`;
    const lines = readFileSync(report, "utf8").split("\n");
    const findingsLine = lines.find((l) => l.startsWith("**Findings:**")) || "";
    return `run ${runId}: ${findingsLine.replace(/\*/g, "")}`.trim();
  } catch {
    return "(NightShift state unreadable)";
  }
}

function fleetStatus(): string {
  try {
    const agents = listAgents();
    if (!agents.length) return "no agents running";
    return agents.map((a) => `${a.name}: ${a.status}`).join(", ");
  } catch {
    return "fleet unreadable";
  }
}

/**
 * Standing goals — the active long-horizon goals and each one's last verified
 * tick. This is what makes the morning brief say "your coverage goal is still
 * blocked — verify failed last night" instead of going silent on autonomy.
 * Fails soft: an unreadable ledger is a finding, never an exception.
 */
function goalsSection(): string {
  try {
    const active = listGoals().filter((g) => g.status === "active" || g.status === "blocked");
    if (!active.length) return "no standing goals";
    return active
      .map((g) => {
        const last = g.lastTick
          ? `${g.lastTick.status}${g.lastTick.note ? ` — ${g.lastTick.note}` : ""}${
              g.lastTick.evidence ? ` [${g.lastTick.evidence.slice(0, 120)}]` : ""
            }`
          : "not yet ticked";
        return `${g.slug} (${g.status}): ${last}`;
      })
      .join(" · ");
  } catch {
    return "goals unreadable";
  }
}

/**
 * Tailscale reachability — is the mesh up, and how many peers can we see? This
 * is what lets the brief say "tailscale is down, the phone can't reach the Mac"
 * before the owner discovers it the hard way.
 *
 * Tailscale is NOT installed yet, so the load-bearing behavior today is the
 * graceful-degrade line: a missing binary (execFile ENOENT) becomes
 * "tailscale: not installed", never an exception. Once installed, a running
 * daemon reports its backend state, this node's name, and the peer count.
 */
let tailscaleBin = "tailscale";

/** Test seam only — point the probe at a stub (or a missing path) so we can
 *  assert both the installed and not-installed lines. Real callers never set it. */
export function setTailscaleBin(bin: string): void {
  tailscaleBin = bin;
}

export function tailscaleStatus(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      tailscaleBin,
      ["status", "--json"],
      { timeout: 3000 },
      (error, stdout) => {
        if (error) {
          // ENOENT = the CLI isn't installed (the expected state today). Any
          // other error (daemon stopped, not logged in) is still a finding, not
          // a throw — surface a short reason.
          const why =
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "not installed"
              : error.message?.split("\n")[0]?.slice(0, 80) || "unavailable";
          resolve(`tailscale: ${why}`);
          return;
        }
        try {
          const s = JSON.parse(stdout);
          const backend = s.BackendState || "unknown";
          const self = (s.Self?.DNSName || "").replace(/\.$/, "");
          const peers = s.Peer ? Object.keys(s.Peer).length : 0;
          resolve(
            `tailscale: ${backend}${self ? ` (${self})` : ""}, ${peers} peer${peers === 1 ? "" : "s"}`
          );
        } catch {
          resolve("tailscale: running (unparseable status)");
        }
      }
    );
  });
}

/**
 * Push-transport health — the last delivery outcome so the brief can say "your
 * last push FAILED" instead of assuming the phone got it. lib/push.ts journals
 * every attempt through /api/push as a `Push.toPhone` entry whose summary is
 * `[priority]` or `[priority FAILED]`; we read that trail rather than reaching
 * into the transport chain, so no coupling and no new state to maintain. The
 * day-0 chain is a single Discord transport, so the aggregate outcome IS the
 * per-transport outcome today; when ntfy/APNs are prepended this still reports
 * the chain's real last result. Fails soft: an unreadable journal is a finding.
 */
export function pushTransportHealth(): string {
  try {
    // readJournal returns newest-first, so entries[0] is the latest attempt.
    const entries = readJournal(200).filter((e) => e.tool === "Push.toPhone");
    if (!entries.length) return "discord: no push attempts recorded";
    const recent = entries.slice(0, 20);
    const failures = recent.filter((e) => /FAILED/.test(e.summary)).length;
    const latestFailed = /FAILED/.test(entries[0].summary);
    const when = new Date(entries[0].ts).toISOString();
    return `discord: last ${latestFailed ? "FAILED" : "delivered"} at ${when} (${
      recent.length - failures
    }/${recent.length} recent delivered)`;
  } catch {
    return "push transport health unreadable";
  }
}

export async function gatherStandingReport(): Promise<string> {
  const ops = loadOpsConfig();
  const [services, dgVerdicts, tailscale] = await Promise.all([
    Promise.all(ops.services.map((s) => probeService(s.name, s.url))),
    deployVerdicts(ops.deployVerdictsDb),
    tailscaleStatus(),
  ]);
  // No portfolio configured → say so honestly rather than an empty line.
  const servicesLine = services.length ? services.join(" · ") : "no services configured";
  return [
    `SERVICES: ${servicesLine}`,
    `DEPLOY VERDICTS (latest per project): ${dgVerdicts}`,
    `TAILSCALE: ${tailscale}`,
    `PUSH TRANSPORTS (last delivery outcome): ${pushTransportHealth()}`,
    `AGENT FLEET: ${fleetStatus()}`,
    `STANDING GOALS: ${goalsSection()}`,
    `NIGHTSHIFT LATEST: ${latestNightShift(ops.nightshiftDir)}`,
    `LATEST BRIEFING:\n${todaysBriefing()}`,
  ].join("\n\n");
}
