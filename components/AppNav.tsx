"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppearanceToggle } from "./AppearanceToggle";
import { usePersonaName } from "./usePersonaName";

/**
 * Fleet ("Work") visibility. Chat resolves the owner gate itself and passes
 * showFleet explicitly; every other page used to rely on the `true` default,
 * which leaked the Work entry to non-owner installs on /prompter, /desk,
 * /journal, /memory, and /setup (2026-07-12 audit). When the prop is absent
 * the rail now asks /api/onboarding itself — fail-closed, so a customer never
 * sees an entry that 404s on them.
 */
function useFleetVisible(explicit?: boolean): boolean {
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    if (explicit !== undefined) return;
    fetch("/api/onboarding")
      .then((r) => r.json())
      .then((j) => setOwner(j?.ownerInstall === true || j?.actModeAllowed === true))
      .catch(() => {
        /* stay hidden on a failed read */
      });
  }, [explicit]);
  return explicit ?? owner;
}

export type NavDest =
  | "rooms"
  | "threads"
  | "fleet"
  | "journal"
  | "memory"
  | "plan"
  | "approvals"
  | "setup";

/**
 * Shared Vidi Current navigation: the desktop navigation desk (left column)
 * and the mobile bottom tab bar. Rooms/Threads are in-page states on the chat
 * page, so it takes optional callbacks; pages without those states (Fleet,
 * Journal) fall back to plain links ("/?threads=1" opens the drawer there).
 */
interface NavProps {
  /** Which rail row is current; omit on pages with no rail row (e.g. /quota). */
  active?: NavDest;
  onRooms?: () => void;
  onThreads?: () => void;
  /**
   * Whether to render the Fleet item. Owner installs see it (default true, so
   * every existing caller is unchanged); a non-owner install hides it — the
   * capability isn't removed (/canvas still exists), only its nav entry. See
   * lib/ui-gating.ts shouldShowFleet.
   */
  showFleet?: boolean;
}

// One cohesive rounded-outline icon family (handoff §8). Inline SVGs, stroke =
// currentColor so they inherit the row's text color in both appearances.
const ICON_PATHS: Record<NavDest, string> = {
  rooms: "M3 10.2 12 3l9 7.2M5.4 8.6V20a1 1 0 0 0 1 1h11.2a1 1 0 0 0 1-1V8.6",
  threads: "M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.2V16.5H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z",
  fleet: "M4 8.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM9 8.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2.5",
  journal: "M6 3.5h11a1 1 0 0 1 1 1V20a.5.5 0 0 1-.5.5H7A2.5 2.5 0 0 1 4.5 18V6A2.5 2.5 0 0 1 7 3.5ZM4.5 18A2.5 2.5 0 0 1 7 15.5h11M8.5 7.5h6M8.5 10.5h6",
  memory: "M12 6.2S9.8 4 6.6 4C4.6 4 3 5 3 5v12s1.6-1 3.6-1c3.2 0 5.4 2 5.4 2s2.2-2 5.4-2c2 0 3.6 1 3.6 1V5s-1.6-1-3.6-1C14.2 4 12 6.2 12 6.2Zm0 0V18",
  plan: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2h5c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3Z",
  approvals: "M4 13.5 6 5.5h12l2 8M4 13.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5.5M4 13.5h4l1.5 2.5h5l1.5-2.5h4",
  setup: "M9.6 20.4l-.5-2a6.9 6.9 0 0 1-1.5-.9l-2 .6-2-3.4 1.5-1.4a7 7 0 0 1 0-1.8L3.6 10l2-3.4 2 .6a6.9 6.9 0 0 1 1.5-.9l.5-2h4.8l.5 2c.5.2 1 .5 1.5.9l2-.6 2 3.4-1.5 1.4a7 7 0 0 1 0 1.8l1.5 1.4-2 3.4-2-.6a6.9 6.9 0 0 1-1.5.9l-.5 2H9.6Z",
};

function NavIcon({ dest }: { dest: NavDest }) {
  return (
    <svg
      className="vc-nav-icon"
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[dest]} />
    </svg>
  );
}

// Frost rail labels. Internal NavDest keys (rooms/fleet) are unchanged to keep
// route/state semantics intact — only the visible labels move to the approved
// Home/Work naming (SURFACE_SPECS §1: Home, Threads, Work, Memory).
const LABEL: Record<NavDest, string> = {
  rooms: "Home",
  threads: "Threads",
  fleet: "Work",
  journal: "Journal",
  memory: "Memory",
  plan: "Plan",
  approvals: "Approvals",
  setup: "Setup",
};

function DeskItem({
  dest,
  active,
  onClick,
  href,
}: {
  dest: NavDest;
  active?: NavDest;
  onClick?: () => void;
  href: string;
}) {
  const isActive = active === dest;
  // Label stays in the DOM (accessible name) but is visually hidden in the
  // compact icon rail; `title` supplies a supplemental tooltip there.
  const inner = (
    <>
      <NavIcon dest={dest} />
      <span className="vc-desk-label-text">{LABEL[dest]}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        className={`vc-desk-item ${isActive ? "active" : ""}`}
        aria-current={isActive ? "page" : undefined}
        title={LABEL[dest]}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }
  return (
    <Link
      className={`vc-desk-item ${isActive ? "active" : ""}`}
      aria-current={isActive ? "page" : undefined}
      title={LABEL[dest]}
      href={href}
    >
      {inner}
    </Link>
  );
}

export function NavDesk({
  active,
  onRooms,
  onThreads,
  showFleet,
  // Retained for source compatibility with existing callers (Memory/Canvas/
  // Journal pass these); the Frost rail no longer renders a voice-bridge panel.
  captureLabel: _captureLabel,
  captureTitle: _captureTitle,
  captureBody: _captureBody,
  footer,
  onSettings,
}: NavProps & {
  captureLabel?: string;
  captureTitle?: string;
  captureBody?: string;
  footer?: string;
  onSettings?: () => void;
}) {
  const personaName = usePersonaName();
  const fleetVisible = useFleetVisible(showFleet);
  return (
    <aside className="vc-desk">
      <div className="vc-brand">
        {/* data-monogram feeds the compact icon rail's single-letter brand. */}
        <p className="vc-brand-name" data-monogram={(personaName[0] || "V").toUpperCase()}>
          {personaName}
        </p>
      </div>
      <nav aria-label="Workspace" className="vc-desk-primary">
        <div className="vc-desk-nav">
          <DeskItem dest="rooms" active={active} onClick={onRooms} href="/" />
          <DeskItem
            dest="threads"
            active={active}
            onClick={onThreads}
            href="/?threads=1"
          />
          {fleetVisible && <DeskItem dest="fleet" active={active} href="/canvas" />}
          <DeskItem dest="memory" active={active} href="/memory" />
          {/* ?home=1: clicking Plan while already inside a plan returns to its
              landing (Prompter confirms first mid-walk). */}
          <DeskItem dest="plan" active={active} href="/prompter?home=1" />
          <DeskItem dest="approvals" active={active} href="/desk" />
          <div className="vc-desk-divider" role="separator" />
          <DeskItem dest="journal" active={active} href="/journal" />
        </div>
      </nav>
      <div className="vc-desk-spacer" />
      <div className="vc-desk-bottom">
        <AppearanceToggle compact />
        <Link
          className={`vc-desk-settings ${active === "setup" ? "active" : ""}`}
          aria-current={active === "setup" ? "page" : undefined}
          href="/setup"
          title="Setup health"
        >
          <HealthGlyph />
          <span className="vc-desk-label-text">Setup</span>
        </Link>
        {footer && <p className="vc-desk-footnote">{footer}</p>}
        {/* Self-contained feedback link: deep-links the compose screen open via
            the ?feedback=1 param (Chat reads it), matching the Settings link. */}
        <Link className="vc-desk-settings" href="/?feedback=1" title="Send feedback">
          <FeedbackGlyph />
          <span className="vc-desk-label-text">Feedback</span>
        </Link>
        {onSettings ? (
          <button className="vc-desk-settings" data-tour="settings" onClick={onSettings} title="Settings">
            <SettingsGlyph />
            <span className="vc-desk-label-text">Settings</span>
          </button>
        ) : (
          <Link className="vc-desk-settings" data-tour="settings" href="/?settings=1" title="Settings">
            <SettingsGlyph />
            <span className="vc-desk-label-text">Settings</span>
          </Link>
        )}
      </div>
    </aside>
  );
}

// Setup-health glyph: a check inside a ring, the same rounded-outline family as
// the nav icons. Its own link (not a NavDest) so no primary item lights up wrong.
function HealthGlyph() {
  return (
    <svg
      className="vc-nav-icon"
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M8.2 12.2l2.6 2.6 5-5.4" />
    </svg>
  );
}

function FeedbackGlyph() {
  return (
    <svg
      className="vc-nav-icon"
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.2V16.5H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </svg>
  );
}

function SettingsGlyph() {
  return (
    <svg
      className="vc-nav-icon"
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 12a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-2-1.2l-.4-2.6H8.5l-.4 2.6a7.3 7.3 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 2 1.2l.4 2.6h6l.4-2.6a7.3 7.3 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.07-.4.1-.8.1-1.2Z" />
    </svg>
  );
}

function Tab({
  dest,
  active,
  onClick,
  href,
}: {
  dest: NavDest;
  active?: NavDest;
  onClick?: () => void;
  href: string;
}) {
  const isActive = active === dest;
  const inner = (
    <>
      <NavIcon dest={dest} />
      <span>{LABEL[dest]}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        className={`vc-tab ${isActive ? "active" : ""}`}
        aria-current={isActive ? "page" : undefined}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }
  return (
    <Link
      className={`vc-tab ${isActive ? "active" : ""}`}
      aria-current={isActive ? "page" : undefined}
      href={href}
    >
      {inner}
    </Link>
  );
}

export function BottomNav({ active, onRooms, onThreads, showFleet }: NavProps) {
  const fleetVisible = useFleetVisible(showFleet);
  return (
    <nav className="vc-tabbar" aria-label="Primary">
      <Tab dest="rooms" active={active} onClick={onRooms} href="/" />
      <Tab dest="threads" active={active} onClick={onThreads} href="/?threads=1" />
      {fleetVisible && <Tab dest="fleet" active={active} href="/canvas" />}
      <Tab dest="journal" active={active} href="/journal" />
      <Tab dest="memory" active={active} href="/memory" />
    </nav>
  );
}
