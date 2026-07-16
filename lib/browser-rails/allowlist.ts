/**
 * Browser Rails — per-task domain allowlist enforcement (Phase 1).
 *
 * A browsing task declares the hosts it needs up front; the user approves that
 * list; every navigation and every form submission is then checked against it.
 * A page the agent lands on that is NOT on the list is a hard stop — this is the
 * seam that keeps a prompt-injected page (see THREAT_MODEL) from steering the
 * browser off to an attacker host, and keeps form data from being POSTed to a
 * host the user never approved.
 *
 * Matching rule: exact host OR a subdomain of an allowlisted host, case-folded.
 * No wildcards, no substring games ("evil-example.com" must NOT match
 * "example.com"). Scheme is restricted to http/https; anything else (file:,
 * data:, javascript:, about:) is refused outright.
 */

/** Normalize a user/agent-supplied domain to a bare lowercase host. Strips a
 *  scheme, path, port, and any leading "*." the agent may have typed. Returns
 *  null for input that can't be reduced to a plausible host. */
export function normalizeDomain(input: string): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^\*\./, "");
  // If it carries a scheme or path, let URL do the parsing.
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  } else {
    // Strip a path/port a bare "example.com:8080/x" might carry.
    s = s.split("/")[0].split(":")[0];
  }
  s = s.replace(/\.$/, ""); // trailing-dot FQDN form
  // A host has at least one dot (reject "localhost"-less bare words except
  // literal localhost) and only host-legal characters.
  if (s !== "localhost" && !/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(s)) return null;
  return s;
}

/** Build a validated allowlist from raw agent-declared domains. Invalid entries
 *  are dropped (never silently widened); duplicates collapse. */
export function buildAllowlist(rawDomains: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of rawDomains ?? []) {
    const host = normalizeDomain(raw);
    if (host) out.add(host);
  }
  return [...out];
}

/** Is `host` covered by `allowlist` (exact or subdomain match)? */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return allowlist.some((allowed) => h === allowed || h.endsWith("." + allowed));
}

export interface UrlCheck {
  ok: boolean;
  /** Present when ok=false — plain-language reason for the refusal. */
  reason?: string;
  /** The parsed host, when the URL was well-formed. */
  host?: string;
}

/**
 * Check a full URL against the task allowlist. Enforces http/https only and
 * host membership. This is the single chokepoint both navigation and form
 * submission run through.
 */
export function checkUrl(rawUrl: string, allowlist: readonly string[]): UrlCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Not a valid URL: ${String(rawUrl).slice(0, 80)}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Only http and https are allowed, not ${url.protocol}` };
  }
  const host = url.hostname.toLowerCase();
  if (!hostAllowed(host, allowlist)) {
    return {
      ok: false,
      host,
      reason:
        `${host} is not on the approved list for this task ` +
        `(${allowlist.join(", ") || "no domains approved"}). ` +
        `Ask the user to approve it before going there.`,
    };
  }
  return { ok: true, host };
}
