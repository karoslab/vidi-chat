"use client";

/**
 * Visual cues for first-run onboarding (2026-07-12). The first customer's
 * feedback: the walkthrough was "popup + buttons + text to explain that step";
 * humans learn from pictures. Every step now leads with a small illustration
 * or turns its prose into icon-anchored rows. All art is inline SVG on the
 * shared stroke grammar (1.7 rounded, currentColor) with amber accents via
 * CSS variables — no external assets, works in both appearances, CSP-safe.
 */

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Step 0 — your Mac linked to your own AI account. */
export function ConnectArt() {
  return (
    <svg className="onb-art" viewBox="0 0 320 96" role="img" aria-label="Your Mac connected to your own AI account">
      {/* laptop */}
      <g {...STROKE}>
        <rect x="24" y="22" width="84" height="52" rx="6" />
        <path d="M14 74h104" />
        <path d="M40 38h52M40 48h36" opacity="0.45" />
      </g>
      {/* dashed link with travelling pulse */}
      <path d="M118 48h84" {...STROKE} strokeDasharray="4 6" opacity="0.6" />
      <circle className="onb-art-pulse" cy="48" r="3.2" fill="var(--amber)" stroke="none" />
      {/* account chip */}
      <g {...STROKE}>
        <rect x="212" y="26" width="84" height="44" rx="12" />
        <circle cx="234" cy="48" r="9" />
        <path d="M230.5 48l2.6 2.6 4.8-5.2" stroke="var(--amber)" />
        <path d="M252 42h32M252 54h22" opacity="0.45" />
      </g>
      <text x="66" y="90" textAnchor="middle" className="onb-art-label">Your Mac</text>
      <text x="254" y="90" textAnchor="middle" className="onb-art-label">Your AI account</text>
    </svg>
  );
}

/** Step 0 footer — the two windows, told apart visually (demo-test confusion). */
export function TwoWindowsStrip() {
  return (
    <div className="onb-two-windows" aria-label="The two windows you will see">
      <div className="onb-two-win">
        <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE} aria-hidden="true">
          <rect x="4" y="3.5" width="16" height="17" rx="3" />
          <path d="M8 8.5h8M8 12h8M8 15.5h5" />
          <circle cx="17.2" cy="17.2" r="2.6" fill="var(--amber)" stroke="none" />
        </svg>
        <div>
          <b>Vidi Helper app</b>
          <span>the on and off switch</span>
        </div>
      </div>
      <div className="onb-two-win">
        <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE} aria-hidden="true">
          <path d="M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.2V16.5H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
          <path d="M8 9.5h8M8 12.5h5" opacity="0.5" />
        </svg>
        <div>
          <b>This window</b>
          <span>where we talk</span>
        </div>
      </div>
    </div>
  );
}

export type NoticeIconKind = "see" | "do" | "ask" | "egress";

/** Match a security-notice heading to its icon without touching the copy. */
export function noticeIconKind(heading: string): NoticeIconKind {
  const h = heading.toLowerCase();
  if (h.includes("see")) return "see";
  if (h.includes("can’t") || h.includes("can't") || h.includes("ask")) return "ask";
  if (h.includes("information") || h.includes("goes")) return "egress";
  return "do";
}

export function NoticeIcon({ kind }: { kind: NoticeIconKind }) {
  return (
    <svg className="onb-notice-icon" viewBox="0 0 24 24" width="20" height="20" {...STROKE} aria-hidden="true">
      {kind === "see" && (
        <>
          <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
          <circle cx="12" cy="12" r="2.8" stroke="var(--amber)" />
        </>
      )}
      {kind === "do" && (
        <>
          <path d="M5 19.2l1-4L16.6 4.6a1.4 1.4 0 0 1 2 0l.8.8a1.4 1.4 0 0 1 0 2L8.8 18l-3.8 1.2Z" />
          <path d="M14.6 6.6l2.8 2.8" stroke="var(--amber)" />
        </>
      )}
      {kind === "ask" && (
        <>
          <path d="M12 3l7.5 3v5.2c0 4.6-3.1 7.6-7.5 9.3-4.4-1.7-7.5-4.7-7.5-9.3V6L12 3Z" />
          <path d="M10.2 9.6a1.9 1.9 0 1 1 2.6 1.8c-.7.3-.8.8-.8 1.5M12 15.6v.2" stroke="var(--amber)" />
        </>
      )}
      {kind === "egress" && (
        <>
          <path d="M4 18.5V14M4 14a4.5 4.5 0 0 1 0-9 5.5 5.5 0 0 1 10.6-1.6A4.8 4.8 0 0 1 19.5 8" transform="translate(0 1.5)" />
          <path d="M13 17.5h7.5m0 0-3-3m3 3-3 3" stroke="var(--amber)" />
        </>
      )}
    </svg>
  );
}

export type CapIconKind = "read" | "modes" | "ask" | "control";

export function CapIcon({ kind }: { kind: CapIconKind }) {
  return (
    <svg className="onb-cap-icon" viewBox="0 0 24 24" width="22" height="22" {...STROKE} aria-hidden="true">
      {kind === "read" && (
        <>
          <path d="M12 5.5S10 4 6.8 4C4.9 4 3.5 4.9 3.5 4.9V19s1.4-.9 3.3-.9c3.2 0 5.2 1.9 5.2 1.9s2-1.9 5.2-1.9c1.9 0 3.3.9 3.3.9V4.9S19.1 4 17.2 4C14 4 12 5.5 12 5.5Zm0 0V20" />
        </>
      )}
      {kind === "modes" && (
        <>
          <rect x="3" y="8" width="18" height="8" rx="4" />
          <circle cx="8" cy="12" r="2.6" stroke="var(--amber)" />
        </>
      )}
      {kind === "ask" && (
        <>
          <path d="M12 3l7.5 3v5.2c0 4.6-3.1 7.6-7.5 9.3-4.4-1.7-7.5-4.7-7.5-9.3V6L12 3Z" />
          <path d="M9.4 12l1.9 1.9 3.6-3.9" stroke="var(--amber)" />
        </>
      )}
      {kind === "control" && (
        <>
          <path d="M7.5 11.5V5.8a1.6 1.6 0 0 1 3.2 0v4.9m0-3.1a1.6 1.6 0 0 1 3.2 0v3.1m0-1.9a1.6 1.6 0 0 1 3.2 0v2.4m0-1.2a1.55 1.55 0 0 1 3.1 0V14a7 7 0 0 1-7 7h-1.4a7 7 0 0 1-5.9-3.2L4.6 14.5a1.7 1.7 0 0 1 2.9-1.8l0 0" />
        </>
      )}
    </svg>
  );
}

/** Step 5 — one hub sending three small helpers out. */
export function HelpersArt() {
  return (
    <svg className="onb-art onb-art-sm" viewBox="0 0 320 72" role="img" aria-label="Vidi sending helpers out to work">
      <g {...STROKE}>
        <circle cx="60" cy="36" r="16" />
        <path d="M54 36.5l4 4 8-8.5" stroke="var(--amber)" />
        <path d="M80 28c30-10 60-10 90-4M80 36h95M80 44c30 10 60 10 90 4" strokeDasharray="3 6" opacity="0.55" />
        <circle cx="196" cy="20" r="8" />
        <circle cx="200" cy="36" r="8" />
        <circle cx="196" cy="52" r="8" />
        <path d="M212 20h84M216 36h80M212 52h84" opacity="0.4" />
      </g>
      <text x="60" y="66" textAnchor="middle" className="onb-art-label">Vidi</text>
      <text x="198" y="8" textAnchor="middle" className="onb-art-label">your helpers</text>
    </svg>
  );
}
