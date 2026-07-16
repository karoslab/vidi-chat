"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import Onboarding from "./Onboarding";
import IntroChat from "./IntroChat";
import SpotlightTour, { TOUR_DONE_KEY } from "./onboarding/SpotlightTour";
import SettingsPanel from "./SettingsPanel";
import UpdateBanner from "./UpdateBanner";
import FeedbackCompose from "./feedback/FeedbackCompose";
import { matchFeedbackIntent } from "@/lib/feedback-intent";
import { usePersonaName } from "./usePersonaName";
import { attentionSwarms } from "@/lib/swarm-view";
import { workingCount } from "@/lib/orbit";
import { NavDesk, BottomNav } from "./AppNav";
import { PauseControl } from "./PauseControl";
import { ConfirmCard } from "./ConfirmCard";
import { createMicSession, type MicSession } from "@/lib/voice-mic-session";
import {
  shouldShowFleet,
  advancedCollapsedByDefault,
  showAdvancedDisclosure,
} from "@/lib/ui-gating";

interface ThreadMeta {
  id: string;
  title: string;
  provider: string;
  model: string | null;
  mode?: "plan" | "auto" | "chat" | "act";
  effort?: string;
  updatedAt: number;
  /** True while a provider turn is running server-side on this thread. */
  running?: boolean;
}

/** Survives navigation to /canvas and back — the page component doesn't. */
const LAST_THREAD_KEY = "vidi:lastThreadId";

/**
 * Threads waiting on a delegated background agent, keyed per-thread in
 * localStorage (value = agentId) so the wait survives the Canvas round-trip
 * that unmounts this page. Cleared when the agent's answer lands.
 */
const AGENT_PENDING_PREFIX = "vidi:agentPending:";

type Mode = "plan" | "auto";
type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Legacy thread modes: chat→plan, act→auto. */
function normMode(m: unknown): Mode {
  return m === "auto" || m === "act" ? "auto" : "plan";
}

const EFFORT_IDS: Effort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
function normEffort(e: unknown): Effort {
  return typeof e === "string" && (EFFORT_IDS as string[]).includes(e)
    ? (e as Effort)
    : "medium";
}

/** The effort slider's six discrete stops, Faster → Smarter (FIX 6). `tick` is
 *  the compact label under each stop; `name` is the full name shown in the
 *  "Effort: …" readout. The internal ladder is low<medium<high<xhigh<max<ultra;
 *  "Extra" = xhigh, "Ultracode" = ultra (top — opus + the ultracode keyword on
 *  Claude; each provider clamps a level above its ceiling down). */
const EFFORTS: { id: Effort; tick: string; name: string }[] = [
  { id: "low", tick: "Low", name: "Low" },
  { id: "medium", tick: "Med", name: "Medium" },
  { id: "high", tick: "High", name: "High" },
  { id: "xhigh", tick: "Extra", name: "Extra" },
  { id: "max", tick: "Max", name: "Max" },
  { id: "ultra", tick: "Ultracode", name: "Ultracode" },
];

interface SwarmWorkerLite {
  name: string | null;
  branch: string;
  status: string;
  pr: number | null;
  activity: string[];
}
interface SwarmRepoLite {
  repo: string;
  workers: SwarmWorkerLite[];
}


interface JournalEntry {
  ts: number;
  threadId: string;
  tool: string;
  summary: string;
}

/** An attachment already saved server-side (persisted on the message). */
interface MsgAttachment {
  id: string;
  name: string;
  kind: "image" | "file";
  size: number;
  rel: string;
}

/** A file in the composer, mid- or post-upload. `previewUrl` is a local object
 *  URL for image thumbnails before the server round-trip; revoked on remove/send. */
interface PendingAtt {
  localId: string;
  name: string;
  kind: "image" | "file";
  size: number;
  status: "uploading" | "ready" | "error";
  rel?: string;
  id?: string;
  previewUrl?: string;
  error?: string;
}

interface Message {
  role: "user" | "assistant";
  text: string;
  ts: number;
  // Honest reasoning signal for this turn (live session only; never persisted
  // redacted text). Present only when the turn actually reasoned.
  reasoning?: { tokens?: number };
  // Files the user attached to this (user) message.
  attachments?: MsgAttachment[];
  // Assistant messages only: the stop button cut this turn short — `text` is
  // whatever had streamed so far, not a complete reply.
  stopped?: boolean;
}

// Mirror the server limits (lib/attachments.ts) so the user isn't told "too big"
// only after a long upload.
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface ProviderInfo {
  id: string;
  label: string;
  models: { id: string; label: string; default?: boolean }[];
  available: boolean;
  reason: string | null;
}

/** Collapsed, unobtrusive "reasoning happened" badge — honest presence +
 *  optional real thinking-token count. Renders nothing when the turn didn't
 *  reason. Never shows redacted thinking text. */
function ReasonedPill({ reasoning }: { reasoning?: { tokens?: number } }) {
  if (!reasoning) return null;
  return (
    <span className="reasoned-pill" title="This turn used extended reasoning">
      🧠 Reasoned
      {typeof reasoning.tokens === "number" ? ` · ${reasoning.tokens} tokens` : ""}
    </span>
  );
}

/** Marks a reply the stop button cut short — the text above it is whatever
 *  had streamed so far, not a complete answer. */
function StoppedPill() {
  return (
    <span className="reasoned-pill" title="You stopped this answer before it finished">
      ⏹ Stopped
    </span>
  );
}

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The design's send glyph — a 3-segment up-arrow; inherits the button's
    dark-ink-on-coral color via currentColor (--vidi-text-on-accent). */
function SendArrow() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M9 14.5V3.5M4.5 8L9 3.5L13.5 8"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Context-ribbon icons — same cohesive rounded-outline family as the rail. */
function RibbonIcon({ kind }: { kind: "recent" | "work" | "memory" }) {
  const paths: Record<typeof kind, string> = {
    recent:
      "M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.2V16.5H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z",
    work: "M4 8.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM9 8.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2.5",
    memory:
      "M12 6.2S9.8 4 6.6 4C4.6 4 3 5 3 5v12s1.6-1 3.6-1c3.2 0 5.4 2 5.4 2s2.2-2 5.4-2c2 0 3.6 1 3.6 1V5s-1.6-1-3.6-1C14.2 4 12 6.2 12 6.2Zm0 0V18",
  };
  return (
    <svg
      className="ribbon-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

/** The three voice bars; they dance only while actually listening (per spec). */
function VoiceBars({ listening }: { listening: boolean }) {
  return (
    <span className={`voice-bars ${listening ? "dancing" : ""}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * Streaming SSE text revealed word-by-word (the design's `word-in`). Each word
 * is one keyed span; already-mounted spans are reused across re-renders (they
 * don't re-animate), so only the words that just arrived fade/blur in — the
 * per-chunk materialize effect. Reduced-motion shows every word immediately
 * (handled in CSS). Plain text (not markdown) is fine for the in-flight bubble;
 * the persisted reply re-renders as full markdown once the turn finishes.
 */
function StreamingText({ text }: { text: string }) {
  const words = text.split(/(\s+)/); // keep whitespace tokens so spacing survives
  return (
    <>
      {words.map((w, i) =>
        /\s/.test(w) ? (
          w
        ) : (
          <span className="stream-word" key={i}>
            {w}
          </span>
        )
      )}
    </>
  );
}

export default function Chat() {
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [providersInfo, setProvidersInfo] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState("claude");
  const [accounts, setAccounts] = useState<{ id: string; label: string }[]>([]);
  const [activeAccount, setActiveAccount] = useState("");
  const [model, setModel] = useState("auto");
  const [mode, setMode] = useState<Mode>("plan");
  const [effort, setEffort] = useState<Effort>("medium");
  const [input, setInput] = useState("");
  /**
   * Live streams keyed by thread id ("__new__" until the server assigns one).
   * Per-thread, not global: switching threads mid-turn must neither lose the
   * stream nor paint it (or its final message) into the wrong thread.
   */
  const [streams, setStreams] = useState<
    Record<
      string,
      {
        text: string;
        toolLine: string | null;
        /** Rolling log of tool lines this turn — feeds the margin rail. */
        tools: string[];
        reasoning?: { tokens?: number };
      }
    >
  >({});
  // Rooms (the spatial landing) vs. the open thread document. Rooms is the
  // default landing; opening a room flips to the thread and "Back" returns
  // WITHOUT tearing the thread state down, so context/scroll are preserved.
  const [showRooms, setShowRooms] = useState(true);
  // Per-room scroll positions, restored when a room comes back forward.
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const scrollPosRef = useRef<Record<string, number>>({});
  // True when the reader is at (or near) the bottom of the open thread. While
  // she streams, we only auto-scroll if this is true — so scrolling up to read
  // the conversation mid-reply is never yanked back down (2026-07-12 demo).
  const atBottomRef = useRef(true);
  // Whether a NEW chat should open in Build (auto): true only for a
  // builder-enabled customer. Kept in a ref so newChat (declared earlier than
  // the owner/act resolution) always reads the current value.
  const builderDefaultRef = useRef(false);
  const saveScroll = useCallback(() => {
    const el = threadScrollRef.current;
    const id = activeIdRef.current;
    if (el && id) scrollPosRef.current[id] = el.scrollTop;
  }, []);
  const onThreadScroll = useCallback(() => {
    const el = threadScrollRef.current;
    if (!el) return;
    // Within ~80px of the end counts as "reading the bottom".
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    saveScroll();
  }, [saveScroll]);
  // Done-handlers need the thread the user is LOOKING AT when the event
  // lands, not the one captured when send() started.
  const activeIdRef = useRef<string | null>(null);
  // The open thread has a turn running SERVER-side that this page has no
  // stream reader for (we navigated away and back, or reloaded). The reply
  // will persist to the thread; poll until it lands.
  const [activeRunning, setActiveRunning] = useState(false);
  // Thread whose /api/chat stream broke mid-turn (laptop sleep, flaky
  // network). The server-side turn survives client disconnect and persists
  // its reply, so we poll instead of declaring failure.
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  // Server-side live partial for a re-attached/reconnecting turn (GET
  // /api/threads/[id] → thread.live): the text streamed so far, incl. the
  // failover switch notice. Rendered as the in-progress bubble so navigating
  // back mid-turn (or a broken stream) replays what a connected client saw,
  // updating each poll — not just a static "still working" line.
  const [livePartial, setLivePartial] = useState<string | null>(null);
  // threadId → agentId for threads whose answer a background agent owes us.
  const [pendingAgentThreads, setPendingAgentThreads] = useState<
    Record<string, string>
  >({});
  const router = useRouter();
  // Mobile-only off-canvas sidebar (drawer). Ignored at desktop width where the
  // sidebar is a static column; CSS gates the whole thing on the breakpoint.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Composer attachments (screenshots / files for context) + the drop-zone flag.
  const [atts, setAtts] = useState<PendingAtt[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Mirror of `atts` for the unmount cleanup (empty-deps effect can't read
  // state directly) — navigating to /canvas unmounts this page.
  const attsRef = useRef<PendingAtt[]>([]);
  attsRef.current = atts;
  useEffect(
    () => () => {
      for (const a of attsRef.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    },
    []
  );

  // Per-thread promise chain so a follow-up send WAITS for the turn already
  // running there instead of firing a second overlapping fetch (mirrors the
  // server's withTurnLock, lib/store.ts) — lets the composer stay usable
  // while Vidi is still answering. Keyed the same as `streams`.
  const sendChainRef = useRef<Record<string, Promise<void>>>({});
  // The queued follow-up (if any) waiting on that chain — shown as a small
  // strip above the composer so it's clear the message registered.
  const [queuedDraft, setQueuedDraft] = useState<{
    streamKey: string;
    message: string;
    attCount: number;
  } | null>(null);

  /** Auto-grow the composer to fit its content, capped so it can't eat the
   *  screen (mobile clamps lower via CSS max-height). Extracted so the
   *  post-send reset and the onChange handler share one implementation. */
  const growComposer = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, []);

  /** Snap the composer back to one row (after send / new chat) — without this
   *  the box stays at its grown height until the next keystroke. */
  const resetComposerHeight = useCallback(() => {
    if (taRef.current) taRef.current.style.height = "auto";
  }, []);

  /** Upload picked/pasted/dropped files: show each as a pending chip, POST them
   *  to /api/attachments, then flip each to ready (with its server rel/id) or
   *  error. Client-side mirrors the server's count/size limits. */
  const uploadFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;
      const room = MAX_ATTACHMENTS - atts.length;
      if (room <= 0) {
        setError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
        return;
      }
      const accepted = files.slice(0, room).filter((f) => {
        if (f.size > MAX_ATTACHMENT_BYTES) {
          setError(`${f.name} is over 20MB, skipped.`);
          return false;
        }
        return true;
      });
      if (accepted.length === 0) return;

      const pending: PendingAtt[] = accepted.map((f, i) => ({
        localId: `${Date.now()}-${i}-${f.name}`,
        name: f.name,
        kind: f.type.startsWith("image/") ? "image" : "file",
        size: f.size,
        status: "uploading",
        previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
      }));
      setAtts((a) => [...a, ...pending]);

      try {
        const form = new FormData();
        for (const f of accepted) form.append("files", f);
        const r = await fetch("/api/attachments", { method: "POST", body: form });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `upload failed (${r.status})`);
        const uploaded: MsgAttachment[] = j.attachments || [];
        // Match server results back to the pending chips by order.
        setAtts((a) =>
          a.map((p) => {
            const idx = pending.findIndex((pp) => pp.localId === p.localId);
            if (idx < 0 || !uploaded[idx]) return p;
            const u = uploaded[idx];
            return { ...p, status: "ready", id: u.id, rel: u.rel, kind: u.kind };
          })
        );
      } catch (err: any) {
        setAtts((a) =>
          a.map((p) =>
            pending.some((pp) => pp.localId === p.localId)
              ? { ...p, status: "error", error: err?.message || "upload failed" }
              : p
          )
        );
        setError(err?.message || "Couldn't upload that. Try again.");
      }
    },
    [atts.length]
  );

  const removeAtt = useCallback((localId: string) => {
    setAtts((a) => {
      const gone = a.find((p) => p.localId === localId);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return a.filter((p) => p.localId !== localId);
    });
  }, []);

  // First-run onboarding (P4.1). `null` = not checked yet (render nothing
  // onboarding-related), true = onboarded (existing owner install / after
  // finishing the flow), false = show the flow. An existing install always
  // reports onboarded:true.
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [personalities, setPersonalities] = useState<
    { id: string; label: string; blurb: string }[]
  >([]);
  // Owner-install flag (V2 second-user track): picks which security-notice
  // story the onboarding screen tells (owner = they can flip Plan→Auto
  // themselves, voice is live). false until the API answers — the
  // conservative story.
  const [ownerInstall, setOwnerInstall] = useState(false);
  // Has the owner/non-owner signal actually resolved from /api/onboarding yet?
  // Until it has (or if the call fails) we treat the install as the OWNER so the
  // owner's surface never flashes the simplified one — fail-open to owner.
  const [ownerResolved, setOwnerResolved] = useState(false);
  // Is Auto (act) mode reachable on this install? Owner -> true; a non-owner is
  // clamped unless the owner set VIDI_ACT_OPT_IN. Defaults true (owner-permissive)
  // until the API answers, so the owner's Plan/Auto toggle never flickers.
  const [actAllowed, setActAllowed] = useState(true);
  // How Vidi addresses the user in the greeting — from the saved profile /
  // user-config; falls back to a name-free greeting until it loads.
  const [displayName, setDisplayName] = useState<string | null>(null);
  // The BRAND stays "Vidi" (title, launcher, docs), but the persona self-name
  // is per-install (2026-07-11 ruling) — a customer's "Anna" must show in the
  // composer, turn labels, and mode hints, and update live on rename.
  const assistantName = usePersonaName();
  // Settings panel (T1.3) — opened from the sidebar footer.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // One-time spotlight tour, queued by first-run onboarding and shown after
  // the intro chat closes (when the real composer is finally on screen).
  const [tourOpen, setTourOpen] = useState(false);
  const pendingTourRef = useRef(false);
  // Which tab the settings panel opens on (deep links like ?settings=voice).
  const [settingsTab, setSettingsTab] = useState<
    "general" | "voice" | "setup" | "privacy" | "updates" | undefined
  >(undefined);
  const searchParams = useSearchParams();
  const searchParamsString = searchParams?.toString() ?? "";
  // Feedback compose (DIAGNOSTICS + FEEDBACK loop). `feedbackOpen` shows the
  // compose-with-preview screen; `feedbackPrefill` seeds it from the chat intent
  // chip; `feedbackOffer` is the gentle one-time ask-on-error prompt.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackPrefill, setFeedbackPrefill] = useState("");
  const [feedbackOffer, setFeedbackOffer] = useState(false);
  // Onboarding replay (T1.5) — "Show me the intro again" from settings. Replay
  // re-renders the flow WITHOUT rewriting the profile.
  const [replayIntro, setReplayIntro] = useState(false);
  // FW3 — a deferred checklist item deep-linked into onboarding AT its step in a
  // completing (non-replay) scoped mode. null = not open.
  const [scopedStep, setScopedStep] = useState<string | null>(null);
  // Onboarding intro chat (T2.2) — the scripted-but-conversational first
  // session shown after a fresh install FINISHES the 4-step flow (never in
  // replay). Also re-triggerable from settings alongside the flow replay.
  const [introChatActive, setIntroChatActive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/onboarding")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setOnboarded(!!j.onboarded);
        setPersonalities(j.personalities || []);
        setOwnerInstall(j.ownerInstall === true);
        setActAllowed(j.actModeAllowed !== false);
        setOwnerResolved(true);
        if (j.displayName) setDisplayName(j.displayName);
      })
      .catch(() => {
        // Fail-open: if the check itself fails, don't trap the user behind an
        // onboarding wall — assume onboarded so the app stays usable.
        if (!cancelled) setOnboarded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshThreads = useCallback(async () => {
    const r = await fetch("/api/threads");
    const j = await r.json();
    setThreads(j.threads || []);
  }, []);

  // Claude account registry + active id. Re-fetched after each turn because a
  // mid-turn usage-limit failover switches the active account server-side.
  const refreshAccounts = useCallback(async () => {
    try {
      const j = await (await fetch("/api/accounts")).json();
      setAccounts(j.accounts || []);
      setActiveAccount(j.activeId || "");
    } catch {
      /* accounts endpoint unavailable — hide the switcher */
    }
  }, []);

  const switchAccount = useCallback(
    async (id: string) => {
      setActiveAccount(id); // optimistic
      try {
        await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
      } catch {
        refreshAccounts(); // revert to server truth on failure
      }
    },
    [refreshAccounts]
  );

  // ── Voice: tap the mic, speak, Vidi answers (and acts) ──────────────
  // STT is the browser's Web Speech API, replies go through the same
  // /api/voice-command pipeline the menu-bar app uses — kill switch, fleet
  // intents (spawn/ask/loop), memory recall, then a normal act turn on the
  // persistent voice thread. TTS is speechSynthesis. No API keys anywhere.
  const [micSupported, setMicSupported] = useState(false);
  const [micState, setMicState] = useState<"idle" | "listening" | "thinking">("idle");
  const [voiceInterim, setVoiceInterim] = useState("");
  const [voiceLine, setVoiceLine] = useState<string | null>(null);
  const [speakOn, setSpeakOn] = useState(true);
  const speakOnRef = useRef(true);
  // Session-scoped mic controller (lib/voice-mic-session): captures only while
  // the user is speaking a turn and releases on every terminal path. Created
  // once; its callbacks read the latest handlers through a ref so the session
  // itself stays stable.
  const micSessionRef = useRef<MicSession | null>(null);

  // Voice tier (2026-07-11): the system voice (speechSynthesis) is the DEFAULT.
  // Premium (worker) TTS is attempted only for the owner or an install that
  // chose the premium tier; everyone else speaks locally with zero egress. Refs
  // so the speak callbacks read the latest values without being re-created.
  const voiceTierRef = useRef<"system" | "premium">("system");
  const voiceOwnerRef = useRef<boolean>(false);
  const systemVoiceRef = useRef<string | null>(null);

  useEffect(() => {
    const w = window as any;
    setMicSupported(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
    const saved = localStorage.getItem("vidi:speak");
    if (saved !== null) {
      speakOnRef.current = saved === "1";
      setSpeakOn(saved === "1");
    }
    // Read the voice config now AND whenever the settings panel saves it —
    // the first design read it only once, so a freshly saved voice code kept
    // speaking in the system voice until a full page reload.
    const refreshVoiceConfig = () => {
      fetch("/api/voice-config")
        .then((r) => r.json())
        .then((j) => {
          voiceTierRef.current = j?.config?.tier === "premium" ? "premium" : "system";
          voiceOwnerRef.current = !!j?.owner;
          systemVoiceRef.current =
            typeof j?.config?.systemVoice === "string" && j.config.systemVoice.trim()
              ? j.config.systemVoice.trim()
              : null;
        })
        .catch(() => {
          /* keep the safe defaults (system tier) on a fetch failure */
        });
    };
    refreshVoiceConfig();
    window.addEventListener("vidi:voice-config-changed", refreshVoiceConfig);
    return () => window.removeEventListener("vidi:voice-config-changed", refreshVoiceConfig);
  }, []);

  // ONE persistent element, reused for every reply: Safari/Chrome gesture
  // rules attach to the element, so playing it once during the mic tap
  // (primeAudio) keeps later async play() calls allowed.
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const getAudioEl = useCallback(() => {
    if (!audioRef.current) audioRef.current = new Audio();
    return audioRef.current;
  }, []);

  /** Call from a real user gesture (mic tap): unlock the element for audio. */
  const primeAudio = useCallback(() => {
    try {
      const el = getAudioEl();
      // Shortest valid silent wav; needs media-src data: in the CSP.
      el.src =
        "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
      el.play().catch(() => {});
      el.pause();
    } catch {
      /* priming is best-effort */
    }
  }, [getAudioEl]);

  /** Pause playback but KEEP the last clip loaded — replay reuses it. */
  const stopSpeaking = useCallback(() => {
    try {
      audioRef.current?.pause();
      window.speechSynthesis?.cancel();
    } catch {
      /* best-effort */
    }
  }, []);

  /** Full stop + drop the cached clip (banner dismissed). */
  const clearAudio = useCallback(() => {
    stopSpeaking();
    try {
      const el = audioRef.current;
      if (el?.src.startsWith("blob:")) URL.revokeObjectURL(el.src);
      el?.removeAttribute("src");
    } catch {
      /* best-effort */
    }
  }, [stopSpeaking]);

  const toggleSpeak = useCallback(() => {
    setSpeakOn((on) => {
      const next = !on;
      speakOnRef.current = next;
      localStorage.setItem("vidi:speak", next ? "1" : "0");
      if (!next) stopSpeaking();
      return next;
    });
  }, [stopSpeaking]);

  /** System-voice fallback for when ara (the TTS proxy) is unreachable. */
  const speakFallback = useCallback((text: string) => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      const voices = synth.getVoices();
      const chosen = systemVoiceRef.current;
      u.voice =
        (chosen ? voices.find((v) => v.name === chosen) : null) ||
        voices.find((v) => v.name === "Samantha") ||
        voices.find((v) => v.lang?.startsWith("en")) ||
        null;
      synth.speak(u);
    } catch {
      /* voice output is best-effort */
    }
  }, []);

  // Vidi's real voice: /api/tts proxies the Grok "ara" voice through the
  // vidi-proxy worker (secret stays server-side). speechSynthesis only as
  // fallback when the proxy is down or offline.
  const speak = useCallback(
    async (text: string) => {
      if (!speakOnRef.current) return;
      stopSpeaking();
      // System tier is the default: skip the worker entirely and speak locally
      // with zero egress. Only the owner or a premium-tier install attempts the
      // worker TTS (and still falls back to the system voice if it fails).
      if (!voiceOwnerRef.current && voiceTierRef.current !== "premium") {
        speakFallback(text);
        return;
      }
      try {
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!r.ok) throw new Error(`tts ${r.status}`);
        const blob = await r.blob();
        if (!speakOnRef.current) return; // muted while we fetched
        const audio = getAudioEl();
        // The previous clip is done for — the new one replaces it as the
        // replayable "last reply". No revoke on ended: ▶ replays it free.
        if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
        audio.src = URL.createObjectURL(blob);
        await audio.play();
      } catch (err) {
        // Loud in the console on purpose — a silent fallback to the system
        // voice cost a debugging round once already.
        console.warn("[vidi] ara TTS failed, falling back to system voice:", err);
        if (speakOnRef.current) speakFallback(text);
      }
    },
    [getAudioEl, speakFallback, stopSpeaking]
  );

  /** ▶ on the banner: re-hear the last reply without re-asking. Replays the
   *  cached clip when we still have it; otherwise re-fetches TTS for the
   *  banner text (covers the speechSynthesis-fallback case too). */
  const replayVoice = useCallback(() => {
    const el = audioRef.current;
    if (el?.src.startsWith("blob:")) {
      try {
        window.speechSynthesis?.cancel();
        el.currentTime = 0;
        el.play().catch(() => {
          if (voiceLine) speak(voiceLine);
        });
        return;
      } catch {
        /* fall through to re-fetch */
      }
    }
    if (voiceLine) speak(voiceLine);
  }, [voiceLine, speak]);

  const voiceSend = useCallback(
    async (transcript: string) => {
      const t = transcript.trim();
      if (!t) return;
      setMicState("thinking");
      setVoiceLine("");
      try {
        const r = await fetch("/api/voice-command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: t }),
        });
        if (!r.ok || !r.body) throw new Error(`voice request failed (${r.status})`);
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let acc = "";
        let result: string | null = null;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            let ev: any;
            try {
              ev = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            if (ev.type === "delta") {
              acc += ev.text;
              setVoiceLine(acc);
            } else if (ev.type === "result") {
              result = ev.text;
            }
          }
        }
        const final = result || acc || "(no reply)";
        setVoiceLine(final);
        speak(final);
        // Spawned agents / voice-thread turns surface elsewhere too.
        refreshThreads();
      } catch (err: any) {
        setVoiceLine(`voice error: ${err?.message || "something went wrong"}`);
      } finally {
        setMicState("idle");
      }
    },
    [refreshThreads, speak]
  );

  // Test hook, same convention as the games' window.FP/PK/MR hooks.
  useEffect(() => {
    (window as any).VC = { voiceSend, replayVoice };
    return () => {
      delete (window as any).VC;
    };
  }, [voiceSend, replayVoice]);

  // The session's callbacks must see the latest voiceSend without re-creating
  // the session (which would leak a hot mic). Keep it in a ref.
  const voiceSendRef = useRef(voiceSend);
  useEffect(() => {
    voiceSendRef.current = voiceSend;
  }, [voiceSend]);

  // Create the mic controller once. It owns the whole capture lifecycle and
  // releases through the mic registry (lib/mic-registry) on every terminal
  // path — turn end, cancel, error, idle, and the Pause-pill/pagehide panic —
  // so Safari's indicator goes dark between turns. There is no hands-free mode:
  // capture is single-utterance push-to-talk by design (privacy over warm-start
  // latency). Re-acquiring next turn is allowed to re-prompt.
  useEffect(() => {
    const session = createMicSession({
      tag: "voice-chat",
      createRecognition: () => {
        const w = window as any;
        const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
        return SR ? new SR() : null;
      },
      onInterim: (text) => setVoiceInterim(text),
      onStateChange: (s) => {
        if (s === "listening") setMicState("listening");
        else setMicState((m) => (m === "thinking" ? m : "idle"));
      },
      onFinal: (text) => voiceSendRef.current(text),
      onError: (kind) =>
        setVoiceLine(
          kind === "not-allowed"
            ? "microphone permission denied. Allow it in the browser and try again"
            : `mic error: ${kind}`
        ),
    });
    micSessionRef.current = session;
    // Backstops that must release the mic even if the browser never fires
    // onend: leaving the page, and the tab going hidden.
    const panic = () => session.cancel("pagehide");
    const onVisibility = () => {
      if (document.visibilityState === "hidden") session.cancel("hidden");
    };
    window.addEventListener("pagehide", panic);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", panic);
      document.removeEventListener("visibilitychange", onVisibility);
      session.dispose();
      micSessionRef.current = null;
    };
  }, []);

  const toggleMic = useCallback(() => {
    // We're inside a real click — unlock the audio element now so ara's
    // reply can play long after this gesture's activation window expires.
    primeAudio();
    const session = micSessionRef.current;
    if (!session) return;
    if (micState === "listening") {
      session.stop();
      return;
    }
    if (micState === "thinking") return;
    setVoiceLine(null);
    setVoiceInterim("");
    session.start();
  }, [micState, primeAudio]);

  useEffect(() => {
    refreshThreads();
    fetch("/api/providers")
      .then((r) => r.json())
      .then((j) => setProvidersInfo(j.providers || []))
      .catch(() => {});
    refreshAccounts();
  }, [refreshThreads, refreshAccounts]);

  // Re-attach to a server-side turn we have no stream reader for: poll the
  // thread until the turn ends, then the persisted reply replaces the wait.
  useEffect(() => {
    if (!activeId || !activeRunning || streams[activeId]) return;
    const id = activeId;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/threads/${id}`);
        if (r.status === 404) {
          // Thread deleted out from under the wait — stop, or the composer
          // stays locked and the spinner spins forever.
          setActiveRunning(false);
          return;
        }
        if (!r.ok) return;
        const j = await r.json();
        if (activeIdRef.current !== id) return;
        setMessages(j.thread.messages || []);
        // Replay the in-flight text streamed so far, updating each poll.
        setLivePartial(j.thread.live?.text ?? null);
        if (!j.thread.running) {
          setActiveRunning(false);
          setLivePartial(null);
          refreshThreads();
        }
      } catch {
        /* transient — next tick retries */
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [activeId, activeRunning, streams, refreshThreads]);

  // A /api/chat stream died mid-turn, but the server-side turn survives
  // client disconnect and persists its reply (app/api/chat/route.ts): poll
  // the thread until the reply lands. Hard-error only when the server itself
  // is unreachable (several consecutive failed polls) or after a generous cap.
  useEffect(() => {
    if (!reconnecting) return;
    const id = reconnecting;
    const deadline = Date.now() + 10 * 60_000;
    let misses = 0;
    const fail = (msg: string) => {
      setReconnecting(null);
      if (activeIdRef.current === id) setError(msg);
    };
    const timer = setInterval(async () => {
      let r: Response;
      try {
        r = await fetch(`/api/threads/${id}`);
      } catch {
        // This is a same-host fetch — repeated rejections mean the server
        // is actually down, not that the earlier stream flaked.
        if (++misses >= 4)
          fail("I couldn't reach my brain just now. Try again in a moment.");
        return;
      }
      misses = 0;
      if (r.status === 404) {
        setReconnecting(null); // thread deleted out from under the wait
        return;
      }
      if (!r.ok) return;
      const j = await r.json();
      const msgs: Message[] = j.thread.messages || [];
      if (activeIdRef.current === id) {
        setMessages(msgs);
        // Replay the in-flight text (incl. failover notice) as the in-progress
        // bubble, refreshed each poll, instead of only the static wait line.
        setLivePartial(j.thread.live?.text ?? null);
      }
      if (!j.thread.running) {
        setReconnecting(null);
        setLivePartial(null);
        refreshThreads();
        // Turn over with no reply persisted — it really died server-side.
        if (msgs[msgs.length - 1]?.role !== "assistant" && activeIdRef.current === id) {
          setError("Something went wrong on my end. Try that again in a moment.");
        }
      } else if (Date.now() > deadline) {
        fail("I couldn't reach my brain just now. Try again in a moment.");
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [reconnecting, refreshThreads]);

  // A delegated background agent owes this thread an answer: poll the fleet
  // until its turn ends, then pull the thread — the agent posted the answer
  // (or its error) there before going idle (reportBackToOrigin).
  useEffect(() => {
    const id = activeId;
    const agentId = id ? pendingAgentThreads[id] : undefined;
    if (!id || !agentId) return;
    const checkAgentDone = async () => {
      try {
        const r = await fetch("/api/agents");
        if (!r.ok) return;
        const j = await r.json();
        const agent = (j.agents || []).find((a: any) => a.id === agentId);
        // Still grinding — keep waiting. Agent gone (closed) also ends the wait.
        if (agent && agent.status === "working") return;
        localStorage.removeItem(AGENT_PENDING_PREFIX + id);
        setPendingAgentThreads((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
        const tr = await fetch(`/api/threads/${id}`);
        if (tr.ok) {
          const tj = await tr.json();
          if (activeIdRef.current === id) setMessages(tj.thread.messages || []);
        }
        refreshThreads();
      } catch {
        /* transient — next tick retries */
      }
    };
    // Check immediately (the agent may have finished while we were on the
    // Canvas), then keep polling.
    checkAgentDone();
    const timer = setInterval(checkAgentDone, 4000);
    return () => clearInterval(timer);
  }, [activeId, pendingAgentThreads, refreshThreads]);

  // Live swarm status in the chat itself — Vidi launches swarms from here,
  // so their progress belongs here too (full detail on the Fleet canvas).
  const [swarms, setSwarms] = useState<SwarmRepoLite[]>([]);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const r = await fetch("/api/swarm");
        const j = await r.json();
        if (!stopped) setSwarms(j.swarms || []);
      } catch {
        /* keep last snapshot */
      }
    };
    load();
    const timer = setInterval(load, 6000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  // Only surface repos with workers that still need the owner's eyes — awaiting
  // their APPROVE PR (pending-approval) or a review that errored (review-error).
  // Merged/closed/in-flight workers drop off; the full board lives on /canvas.
  const attention = attentionSwarms(swarms);

  // Composer control popover (provider / account / model / mode / effort) — the
  // PR #50 harness controls, folded into an on-brand cluster near the composer
  // instead of a persistent sidebar.
  const [controlsOpen, setControlsOpen] = useState(false);
  // Close the controls popover on a press OUTSIDE it. The old invisible
  // backdrop div sat in a higher stacking context than the popover (the glass
  // composer's backdrop-filter traps the popover's z-index), so it swallowed
  // clicks INSIDE the popover too — nothing in it could be selected.
  const controlsWrapRef = useRef<HTMLDivElement | null>(null);
  // The popover opens UPWARD from the composer; cap its height to the real
  // headroom so Advanced never climbs past the top of the window
  // (2026-07-12 demo: the card's top was cut off).
  useEffect(() => {
    if (!controlsOpen) return;
    const wrap = controlsWrapRef.current;
    const pop = wrap?.querySelector<HTMLElement>(".orbit-controls-pop");
    if (!wrap || !pop) return;
    const cap = () => {
      const headroom = wrap.getBoundingClientRect().top - 24;
      pop.style.maxHeight = `${Math.max(180, headroom)}px`;
    };
    cap();
    // Advanced expanding grows the pop after this runs — track its size.
    const ro = new ResizeObserver(cap);
    ro.observe(pop);
    return () => ro.disconnect();
  }, [controlsOpen]);

  useEffect(() => {
    if (!controlsOpen) return;
    const onDown = (e: PointerEvent) => {
      const wrap = controlsWrapRef.current;
      if (wrap && !wrap.contains(e.target as Node)) setControlsOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [controlsOpen]);
  // Owner-vs-non-owner UI gating (lib/ui-gating.ts). effectiveOwner is
  // owner-permissive until the signal resolves (and if it fails), so the owner
  // surface is byte-identical to today and a non-owner only simplifies once the
  // API confirms she is one.
  const effectiveOwner = ownerInstall || !ownerResolved;
  const showFleet = shouldShowFleet(effectiveOwner, actAllowed);
  const advancedFlat = !showAdvancedDisclosure(effectiveOwner);
  // A confirmed non-owner install shows the customer-facing Plan/Build toggle
  // (Build carries the one-time consent). The owner keeps Plan/Auto.
  const isCustomer = ownerResolved && !ownerInstall;
  useEffect(() => {
    builderDefaultRef.current = isCustomer && actAllowed;
    // Reflect the default on a fresh landing (nothing open) once builder
    // status is known — but never override an existing open thread's mode.
    if (builderDefaultRef.current && !activeIdRef.current && messages.length === 0) {
      setMode("auto");
    }
  }, [isCustomer, actAllowed, messages.length]);
  // The Advanced disclosure's open state (non-owner only; the owner renders flat).
  const [advancedOpen, setAdvancedOpen] = useState(
    () => !advancedCollapsedByDefault(false)
  );

  // Fleet agents feed the home orbit's OUTER ring + the working-count caption.
  // A light poll here (the full live SSE feed lives on the Fleet canvas) — only
  // name + status are needed for the chips/caption.
  const [fleetAgents, setFleetAgents] = useState<{ name: string; status: string }[]>([]);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const r = await fetch("/api/agents");
        if (!r.ok) return;
        const j = await r.json();
        if (!stopped)
          setFleetAgents(
            (j.agents || []).map((a: any) => ({ name: a.name, status: a.status }))
          );
      } catch {
        /* keep last snapshot */
      }
    };
    load();
    const timer = setInterval(load, 6000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  // Follow the conversation while it's live (streaming, or a message the
  // user just sent). Opening a room wholesale-replaces `messages` and must
  // NOT jump — the per-room scroll restore in openThread owns that case.
  useEffect(() => {
    const id = activeIdRef.current;
    const live = id ? streams[id] : streams["__new__"];
    const last = messages[messages.length - 1];
    const justSent = last && last.role === "user";
    // A message you just sent always jumps to the bottom; streaming deltas
    // only pull down when you're already reading there.
    if (justSent) {
      atBottomRef.current = true;
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    } else if (live && atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streams]);

  // Mobile drawer: Escape closes it (keyboard/accessibility parity with the
  // backdrop tap and the ✕ button).
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // Tool actions journaled for the OPEN thread (margin rail "grounded in"),
  // fetched best-effort when a room opens; real act-mode history, not chrome.
  const [threadJournal, setThreadJournal] = useState<JournalEntry[]>([]);

  const openThread = useCallback(async (id: string) => {
    setError(null);
    setDrawerOpen(false); // mobile: picking a thread closes the drawer
    saveScroll(); // remember where the previous room was scrolled to
    setShowRooms(false);
    setActiveId(id);
    activeIdRef.current = id;
    fetch("/api/journal")
      .then((r) => r.json())
      .then((j) =>
        setThreadJournal(
          ((j.entries || []) as JournalEntry[]).filter((e) => e.threadId === id)
        )
      )
      .catch(() => setThreadJournal([]));
    setActiveRunning(false);
    setLivePartial(null);
    localStorage.setItem(LAST_THREAD_KEY, id);
    const r = await fetch(`/api/threads/${id}`);
    if (!r.ok) {
      // Deleted or bogus (e.g. a stale restore) — fall back to a clean slate.
      if (activeIdRef.current === id) {
        setActiveId(null);
        activeIdRef.current = null;
        // Only clear the restore key if it pointed at THIS dead id — a bogus
        // ?room= deep link must not wipe an unrelated saved thread.
        if (localStorage.getItem(LAST_THREAD_KEY) === id) {
          localStorage.removeItem(LAST_THREAD_KEY);
        }
      }
      return;
    }
    const j = await r.json();
    // Guard against a slow fetch racing a faster thread switch.
    if (activeIdRef.current !== id) return;
    setMessages(j.thread.messages || []);
    // Restore the room's saved scroll position (or land at the latest turn).
    requestAnimationFrame(() => {
      const el = threadScrollRef.current;
      if (el && activeIdRef.current === id) {
        const saved = scrollPosRef.current[id];
        el.scrollTop = saved !== undefined ? saved : el.scrollHeight;
      }
    });
    setActiveRunning(!!j.thread.running);
    // Opened mid-turn (navigated back): seed the in-progress bubble with the
    // text streamed so far so the failover notice + partial reply show
    // immediately; the re-attach poll keeps it fresh until the reply lands.
    setLivePartial(j.thread.running ? (j.thread.live?.text ?? null) : null);
    // Restore a pending background-agent wait (survives the Canvas trip).
    const pendingAgentId = localStorage.getItem(AGENT_PENDING_PREFIX + id);
    setPendingAgentThreads((p) => {
      if (pendingAgentId) return { ...p, [id]: pendingAgentId };
      if (p[id]) {
        const next = { ...p };
        delete next[id];
        return next;
      }
      return p;
    });
    setProvider(j.thread.provider);
    setMode(normMode(j.thread.mode));
    setEffort(normEffort(j.thread.effort));
    if (j.thread.model) setModel(j.thread.model);
  }, [saveScroll]);

  // Reopen the last thread after navigation (Fleet and back) or reload —
  // client-side nav still unmounts this page component and wipes its state.
  // Deep links win over the restore: ?room=<id|voice> opens that room's
  // thread directly (the Voice panel's Chat extension lands on the shared
  // voice thread this way) and ?threads=1 opens the thread drawer.
  // App-activity ping (DIAGNOSTICS + FEEDBACK loop): counts an active day and,
  // if the weekly health summary is consented AND due, sends it lazily. Fully
  // fire-and-forget — a failure is silent (recorded to the ledger server-side).
  // If the toggle is off (default) this does nothing but count an active day.
  useEffect(() => {
    fetch("/api/diag/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {
      /* never blocks the UI */
    });
  }, []);

  // Reactive to the URL (useSearchParams), not a mount-once read: the rail's
  // Feedback/Settings links navigate to /?feedback=1 FROM the home page, where
  // a mount-once effect never re-fires (2026-07-12: dead Feedback button).
  useEffect(() => {
    const params = new URLSearchParams(searchParamsString);
    if (params.get("threads") === "1") setDrawerOpen(true);
    // Rail "Settings" on pages without an in-page callback deep-links here.
    const settingsParam = params.get("settings");
    if (settingsParam) {
      // "?settings=1" opens the panel; "?settings=voice" (or general/setup/
      // privacy) opens it ON that tab — journey steps deep-link the Voice tab.
      if (["voice", "general", "setup", "privacy"].includes(settingsParam)) {
        setSettingsTab(settingsParam as "voice" | "general" | "setup" | "privacy");
      }
      setSettingsOpen(true);
    }
    // "Ask Vidi" from a setup step lands here with ?ask=1; the step stashed its
    // troubleshooting context in sessionStorage, so pull it into the composer
    // once and clear it (so a reload doesn't re-fill).
    if (params.get("ask") === "1") {
      try {
        const prefill = sessionStorage.getItem("vidi:ask-prefill");
        if (prefill) {
          setInput(prefill);
          sessionStorage.removeItem("vidi:ask-prefill");
        }
      } catch {
        /* storage unavailable — open the composer empty */
      }
    }
    if (params.get("feedback") === "1") setFeedbackOpen(true);
    const room = params.get("room");
    if (room === "voice") {
      fetch("/api/threads")
        .then((r) => r.json())
        .then((j) => {
          const voice = (j.threads || []).find(
            (t: ThreadMeta) => t.title === "voice"
          );
          if (voice) openThread(voice.id);
        })
        .catch(() => {});
      return;
    }
    if (room) {
      openThread(room);
    }
  }, [openThread, searchParamsString]);

  // Mount-once: restore the last thread underneath Rooms when the page opened
  // with no deep-link params at all.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).toString()) return;
    const saved = localStorage.getItem(LAST_THREAD_KEY);
    if (saved) {
      // Restore the working context underneath Rooms (the landing view):
      // the active room card opens it instantly with state intact.
      openThread(saved).then(() => setShowRooms(true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Patch a harness setting on the open thread; else it rides the next send. */
  const patchThread = useCallback(
    async (patch: Record<string, string>) => {
      if (!activeId) return;
      await fetch(`/api/threads/${activeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
      refreshThreads();
    },
    [activeId, refreshThreads]
  );

  /** Toggle plan/auto; persists on the open thread, else applies to the next one. */
  const switchMode = useCallback(
    (m: Mode) => {
      setMode(m);
      patchThread({ mode: m });
    },
    [patchThread]
  );

  const switchEffort = useCallback(
    (e: Effort) => {
      setEffort(e);
      patchThread({ effort: e });
    },
    [patchThread]
  );

  const switchModel = useCallback(
    (m: string) => {
      setModel(m);
      patchThread({ model: m });
    },
    [patchThread]
  );

  const newChat = useCallback(() => {
    setActiveId(null);
    activeIdRef.current = null;
    setActiveRunning(false);
    setLivePartial(null);
    localStorage.removeItem(LAST_THREAD_KEY);
    setMessages([]);
    // A NEW chat opens in the default mode; EXISTING threads keep their own
    // stored mode (openThread restores it). This is the accurate Plan/Auto
    // distinction: switching Build no longer rewrites old plan threads.
    setMode(builderDefaultRef.current ? "auto" : "plan");
    setError(null);
    setAtts((a) => {
      for (const p of a) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      return [];
    });
    resetComposerHeight();
    setDrawerOpen(false); // mobile: starting a new chat closes the drawer
    taRef.current?.focus();
  }, [resetComposerHeight]);

  const deleteThread = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      await fetch(`/api/threads/${id}`, { method: "DELETE" });
      // Drop any live stream for the deleted thread so its bubble/indicator
      // can't linger (the server-side turn keeps running; harmless).
      setStreams((s) => {
        if (!s[id]) return s;
        const next = { ...s };
        delete next[id];
        return next;
      });
      if (id === activeId) newChat();
      refreshThreads();
    },
    [activeId, newChat, refreshThreads]
  );

  const send = useCallback(async () => {
    const message = input.trim();
    // Sending from HOME always starts a fresh thread (2026-07-12 demo: a
    // home send silently continued the last open thread). Replying inside a
    // thread still continues that thread. showRooms is the home-view signal
    // (`view` itself is derived later in the render).
    const originThreadId = showRooms ? null : activeId; // null = new chat
    let streamKey = originThreadId ?? "__new__";
    // Fixed identity for the wait-your-turn chain below — streamKey itself
    // gets re-keyed once a brand-new chat's real thread id comes back.
    const chainKey = streamKey;
    // Wait for in-flight uploads before sending; an image-only send is fine.
    if (atts.some((a) => a.status === "uploading")) return;
    const ready = atts.filter((a) => a.status === "ready");
    if (!message && ready.length === 0) return;
    const readyAtts: MsgAttachment[] = ready.map((a) => ({
      id: a.id!,
      name: a.name,
      kind: a.kind,
      size: a.size,
      rel: a.rel!,
    }));
    // Vidi's already answering on this thread: queue this one instead of
    // dropping it. The composer still clears right away (same feel as a
    // normal send); the transcript append waits until it's actually this
    // call's turn (below) so the reply-in-progress doesn't get shoved out of
    // chronological order by a message that hasn't really been asked yet.
    const wasBusy = !!streams[streamKey];
    setInput("");
    // The uploaded files are already on disk, so the sent bubble loads them via
    // GET /api/attachments — the chips' object URLs are no longer needed. Revoke
    // them all so screenshots don't accumulate blobs for the page's lifetime.
    for (const a of atts) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    setAtts([]);
    resetComposerHeight();
    setError(null);
    // Streaming always happens in the thread document, never behind Rooms.
    setShowRooms(false);
    if (wasBusy) {
      setQueuedDraft({ streamKey, message, attCount: readyAtts.length });
    } else {
      setStreams((s) => ({ ...s, [streamKey]: { text: "", toolLine: null, tools: [] } }));
      setMessages((m) => [
        ...m,
        {
          role: "user",
          text: message,
          ts: Date.now(),
          ...(readyAtts.length ? { attachments: readyAtts } : {}),
        },
      ]);
    }

    // Serialize actual turns per thread (mirrors the server's withTurnLock,
    // lib/store.ts): wait for any turn already running here to fully finish
    // before this one starts, so two overlapping sends never fight over the
    // one streams[] display slot.
    const prevInChain = sendChainRef.current[chainKey] ?? Promise.resolve();
    let releaseChain!: () => void;
    const chainGate = new Promise<void>((resolve) => (releaseChain = resolve));
    sendChainRef.current[chainKey] = chainGate;
    await prevInChain;

    if (wasBusy) {
      setQueuedDraft((q) => (q && q.streamKey === streamKey ? null : q));
      setStreams((s) => ({ ...s, [streamKey]: { text: "", toolLine: null, tools: [] } }));
      // streams[] is thread-keyed so it's always safe to update, but the flat
      // `messages` transcript is "whatever's on screen" — only touch it if
      // the user is still actually looking at this thread.
      if (activeIdRef.current === streamKey) {
        setMessages((m) => [
          ...m,
          {
            role: "user",
            text: message,
            ts: Date.now(),
            ...(readyAtts.length ? { attachments: readyAtts } : {}),
          },
        ]);
      }
    }

    const updateStream = (
      key: string,
      patch: Partial<{ text: string; toolLine: string | null; reasoning: { tokens?: number } }>
    ) => setStreams((s) => (s[key] ? { ...s, [key]: { ...s[key], ...patch } } : s));

    // Set once we have a live SSE response: from that point the server owns
    // the turn and survives our disconnect (app/api/chat/route.ts), so a
    // broken stream means "reconnect and poll", not "the turn failed".
    let streamStarted = false;
    let gotDone = false;
    let gotError = false;
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: originThreadId,
          message,
          provider,
          model,
          mode,
          effort,
          ...(readyAtts.length ? { attachments: readyAtts } : {}),
        }),
      });
      if (!r.ok || !r.body) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `request failed (${r.status})`);
      }
      streamStarted = true;

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      let spawnedAgent = false;
      // Honest reasoning signal for this turn; set by the reasoning event,
      // attached to the finished assistant message on done.
      let reasoning: { tokens?: number } | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;
          let ev: any;
          try {
            ev = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (ev.type === "meta" && ev.threadId && streamKey === "__new__") {
            // New chat got its real id: re-key the stream and follow it —
            // the user was on the composing view, so switching is what they
            // expect (and the ref keeps later events honest if they leave).
            setStreams((s) => {
              const { __new__: pending, ...rest } = s;
              return {
                ...rest,
                [ev.threadId]: pending ?? { text: "", toolLine: null, tools: [] },
              };
            });
            streamKey = ev.threadId;
            // Migrate this call's chain slot too — a follow-up send that
            // arrives after this point reads activeId (now the real id) to
            // decide what it's waiting on, so it must find this gate there,
            // not still parked under "__new__".
            if (sendChainRef.current["__new__"] === chainGate) {
              delete sendChainRef.current["__new__"];
              sendChainRef.current[ev.threadId] = chainGate;
            }
            if (activeIdRef.current === null) {
              setActiveId(ev.threadId);
              activeIdRef.current = ev.threadId;
              localStorage.setItem(LAST_THREAD_KEY, ev.threadId);
            }
            refreshThreads();
          } else if (ev.type === "delta") {
            acc += ev.text;
            updateStream(streamKey, { text: acc });
          } else if (ev.type === "tool") {
            const line = `${ev.tool} · ${ev.summary || ""}`;
            setStreams((s) =>
              s[streamKey]
                ? {
                    ...s,
                    [streamKey]: {
                      ...s[streamKey],
                      toolLine: line,
                      tools: [...s[streamKey].tools, line].slice(-8),
                    },
                  }
                : s
            );
          } else if (ev.type === "reasoning" && ev.reasoned) {
            reasoning = { tokens: typeof ev.tokens === "number" ? ev.tokens : undefined };
            updateStream(streamKey, { reasoning });
          } else if (ev.type === "done") {
            gotDone = true;
            // The server persisted the reply before emitting done, so a
            // thread re-opened later fetches it; only patch the live view.
            if (activeIdRef.current === streamKey) {
              setMessages((m) => [
                ...m,
                {
                  role: "assistant",
                  text: ev.fullText || acc,
                  ts: Date.now(),
                  reasoning,
                  ...(ev.stopped ? { stopped: true } : {}),
                },
              ]);
            }
          } else if (ev.type === "agentSpawned" && ev.agentId) {
            // Vidi delegated this ask to a background agent. Remember the debt
            // on this thread (the meta event has already re-keyed a new chat),
            // then jump to the Canvas after the ack lands so the user watches
            // the agent work; the answer posts back into this thread.
            spawnedAgent = true;
            if (streamKey !== "__new__") {
              localStorage.setItem(AGENT_PENDING_PREFIX + streamKey, ev.agentId);
              const tid = streamKey;
              setPendingAgentThreads((p) => ({ ...p, [tid]: ev.agentId }));
            }
          } else if (ev.type === "error") {
            gotError = true;
            setError(ev.message);
            // ask-on-error: the server decided this repeated failure is worth a
            // gentle, one-time offer to send the owner a report. Never auto-sends.
            if (ev.offerReport) setFeedbackOffer(true);
          }
        }
      }
      if (spawnedAgent) router.push("/canvas");
      // `gotError` is a local, not the `error` state — the state read here
      // would be the stale pre-send closure value, committing unpersisted
      // partial text as a finished message after an error event.
      if (!gotDone && !gotError) {
        if (streamKey !== "__new__") {
          // Stream ended mid-turn without a done event — the server-side
          // turn is likely still running; poll for the persisted reply.
          setReconnecting(streamKey);
        } else if (acc && activeIdRef.current === streamKey) {
          // No thread id to poll; keep what we got.
          setMessages((m) => [...m, { role: "assistant", text: acc, ts: Date.now(), reasoning }]);
        }
      }
    } catch (err: any) {
      // Real detail goes to the console; the banner stays plain-language.
      console.error("[chat] send failed:", err);
      if (streamStarted && !gotDone && !gotError && streamKey !== "__new__") {
        // The turn reached the server before the stream broke (laptop sleep,
        // dropped connection) — it survives our disconnect, so poll instead
        // of claiming failure.
        setReconnecting(streamKey);
      } else {
        setError("I couldn't reach my brain just now. Try again in a moment.");
      }
    } finally {
      setStreams((s) => {
        const next = { ...s };
        delete next[streamKey];
        delete next.__new__;
        return next;
      });
      refreshThreads();
      refreshAccounts(); // a mid-turn failover may have switched the active account
      releaseChain();
      // streamKey (not chainKey): a migrated "__new__" chain now lives under
      // the real thread id, and identity-checking `=== chainGate` before
      // deleting keeps this safe even if a queued call already overwrote it.
      if (sendChainRef.current[streamKey] === chainGate) delete sendChainRef.current[streamKey];
    }
  }, [input, atts, streams, activeId, showRooms, provider, model, mode, effort, resetComposerHeight, refreshThreads, refreshAccounts, router]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Plain Enter sends; ⌘/Ctrl+Enter belongs to the global "enter the
    // foreground room" shortcut and must NOT also send (review blocker: the
    // double-fire could strand a new-thread message behind a room switch).
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
    }
  };

  // Stop button (with confirmation) — POSTs to the per-thread abort endpoint;
  // the turn's own SSE stream (already open in this tab) picks up the
  // resulting `done` and finishes normally, partial answer and all.
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopCurrentTurn = useCallback(async () => {
    const id = activeId;
    setStopConfirmOpen(false);
    if (!id) return;
    setStopping(true);
    try {
      await fetch(`/api/threads/${id}/stop`, { method: "POST" });
    } catch {
      /* the reconnect/poll paths already cover surfacing the outcome */
    } finally {
      setStopping(false);
    }
  }, [activeId]);

  // Stream state for the thread the user is looking at (or the pending
  // new-chat stream). `streaming` gates only THIS view's controls — other
  // threads stay fully usable while a turn runs elsewhere.
  const activeStream = activeId ? streams[activeId] : streams["__new__"];
  // This view's stream broke but the server turn is (probably) still going.
  const reconnectingHere = reconnecting !== null && reconnecting === activeId;
  // Busy = a live stream here, a server-side turn we re-attached to after
  // navigation, OR a broken stream we're polling for. Either way this
  // thread's composer waits its turn.
  const streaming = !!activeStream || activeRunning || reconnectingHere;

  // W5 — a full-screen onboarding surface (the first-run flow or the intro chat,
  // incl. their replay / scoped-step variants) OWNS the screen and has its own
  // input. While one is up, the main composer must NOT be a second, competing
  // live input box: park it (don't render it) so a non-technical user is never
  // shown two input boxes at once and can't type into the wrong one.
  const onboardingOverlayActive =
    (onboarded === false && !introChatActive) ||
    introChatActive ||
    replayIntro ||
    scopedStep !== null;

  const activeProviderInfo = providersInfo.find((p) => p.id === provider);
  const modelOptions =
    activeProviderInfo?.models ??
    (provider === "claude"
      ? [
          { id: "auto", label: "Auto (Vidi routes)", default: true },
          { id: "opus", label: "Opus" },
          { id: "sonnet", label: "Sonnet" },
        ]
      : [{ id: "default", label: "Auto (Vidi routes)", default: true }]);

  // Effort slider: the six stops map to the same per-thread effort state the
  // send/PATCH paths persist — dragging it is NOT cosmetic. Codex's "Auto (Vidi
  // routes)" pseudo-model defers reasoning to ~/.codex/config.toml, so the dial
  // has no CLI effect there and is disabled with a reason; Claude, Grok, and any
  // specific Codex GPT-5.x model all honor the resolved --effort level (clamped
  // down to each provider/model's ceiling).
  const effortIndex = Math.max(
    0,
    EFFORTS.findIndex((e) => e.id === effort)
  );
  const effortDisabledReason =
    provider === "codex" && model === "default"
      ? "“Auto (Vidi routes)” uses Codex's own reasoning level. Pick a GPT-5.x model to set effort here"
      : null;

  // ── Vidi Current view derivation ─────────────────────────────────────
  // Rooms (the spatial landing) vs. the open thread document. Rooms shows
  // whenever the user asked for it OR nothing is open; a live stream always
  // pulls the thread forward. Onboarding surfaces win over both (overlays).
  const nothingOpen =
    !activeId && messages.length === 0 && !activeStream && !activeRunning && !reconnectingHere;
  const view: "rooms" | "thread" = showRooms || nothingOpen ? "rooms" : "thread";

  // Home foreground context: the active thread, else the most recent. Drives
  // the empty-state copy and ⌘↵ ("enter the current room").
  const foregroundRoom = (activeId && threads.find((t) => t.id === activeId)) || threads[0] || null;

  // Count of real work in motion (fleet agents + swarm workers) for the Home
  // context ribbon's "Active work" segment — real state only, omitted if zero.
  const busyCount = workingCount({
    swarms: swarms.map((s) => ({
      repo: s.repo,
      workers: s.workers.map((w) => ({ status: w.status, pr: w.pr })),
    })),
    agents: fleetAgents,
  });

  // Thread header meta.
  const activeThread = threads.find((t) => t.id === activeId) || null;
  const providerLabel =
    provider === "claude"
      ? "Claude Max"
      : provider === "codex"
        ? "Codex"
        : provider === "grok"
          ? "Grok"
          : provider;
  const modelLabel = modelOptions.find((m) => m.id === model)?.label || model;

  // Live tool activity for the streaming Vidi label ("Vidi · read 12 files"),
  // derived from the SSE tool line ("tool · summary").
  const streamToolLabel = (() => {
    const line = activeStream?.toolLine;
    if (!line) return null;
    const [tool, ...rest] = line.split(" · ");
    const summary = rest.join(" · ").trim();
    return summary ? `${tool} ${summary}` : tool;
  })();

  // The voice room is the persistent thread shared with the macOS Vidi Voice
  // app — its user turns arrived as transcripts, and are labeled as such.
  const isVoiceRoom = activeThread?.title === "voice";

  // Back to Rooms without tearing the open thread down (context preserved).
  const backToRooms = useCallback(() => {
    saveScroll();
    setShowRooms(true);
  }, [saveScroll]);

  // ⌘K finds a room (opens the thread drawer); ⌘↵ enters the foreground room.
  const foregroundRoomId = foregroundRoom?.id ?? null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDrawerOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && view === "rooms") {
        if (e.defaultPrevented) return; // another handler claimed it
        if (foregroundRoomId) {
          e.preventDefault();
          openThread(foregroundRoomId);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, foregroundRoomId, openThread]);

  // The control popover body (provider / account / model / mode / effort) —
  // shared PR #50 state, same PATCH wiring, restyled to the Orbit tokens. The
  // rows are split out so a NON-owner install can tuck Provider/Account/Model/
  // Effort under a collapsed "Advanced" disclosure (Mode stays visible for
  // everyone). The OWNER renders them flat, in the exact order and markup as
  // before — advancedFlat true (see lib/ui-gating.ts).
  const providerRow = (
    <div className="picker-row">
      <label>Provider</label>
      <select
        value={provider}
        disabled={streaming || (activeId !== null && messages.length > 0)}
        onChange={(e) => {
          const id = e.target.value;
          setProvider(id);
          if (id !== "claude") setMode("plan"); // auto mode is Claude-only
          const info = providersInfo.find((p) => p.id === id);
          const def = info?.models.find((m) => m.default) || info?.models[0];
          setModel(def?.id || (id === "claude" ? "auto" : "default"));
        }}
      >
        <option value="claude">Claude Max</option>
        <option value="codex">Codex (ChatGPT)</option>
        <option value="grok">Grok (xAI)</option>
      </select>
    </div>
  );
  const accountRow = provider === "claude" && accounts.length > 1 && (
    <div className="picker-row">
      <label>Account</label>
      <select
        value={activeAccount}
        disabled={streaming}
        onChange={(e) => switchAccount(e.target.value)}
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    </div>
  );
  // "Auto (Vidi routes)" is its own choice now — a Let-Vidi-choose vs
  // Pick-a-model toggle, not one row buried in the model list (2026-07-12
  // customer ask). "Let Vidi choose" applies the global rule: deep planning on
  // the top model, execution on a faster one. Only when the customer picks a
  // model does the specific-model dropdown appear. Non-claude providers keep
  // the plain dropdown (their "auto" defers to the provider's own config).
  const specificModels = modelOptions.filter((m) => m.id !== "auto" && m.id !== "default");
  const firstSpecific = specificModels[0]?.id ?? "opus";
  const modelRow =
    provider === "claude" && specificModels.length > 0 ? (
      <div className="picker-row">
        <label>Model</label>
        <div className="model-route-toggle">
          <button
            className={model === "auto" ? "on" : ""}
            disabled={streaming}
            onClick={() => switchModel("auto")}
          >
            Let {assistantName}{" "}choose
          </button>
          <button
            className={model !== "auto" ? "on" : ""}
            disabled={streaming}
            onClick={() => switchModel(firstSpecific)}
          >
            Pick a model
          </button>
        </div>
        {model === "auto" ? (
          <div className="model-route-note">
            Deep thinking for planning, a faster model for the work — chosen for
            you, every turn.
          </div>
        ) : (
          <select value={model} disabled={streaming} onChange={(e) => switchModel(e.target.value)}>
            {specificModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </div>
    ) : (
      <div className="picker-row">
        <label>Model</label>
        <select value={model} disabled={streaming} onChange={(e) => switchModel(e.target.value)}>
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
    );
  const providerNote = activeProviderInfo && !activeProviderInfo.available && (
    <div className="provider-note">{activeProviderInfo.reason}</div>
  );
  const planNote = (
    <div className="mode-note">
      Look and plan only. {assistantName}{" "}reads and thinks, but won&apos;t
      change anything.
    </div>
  );
  // Customer "Build": the first tap (when the opt-in isn't on yet) shows the
  // one-time consent, enables it through the guarded route, then acts. After
  // that it's an ordinary Plan↔Build flip. The server still gates every act,
  // so a tap before the opt-in lands is clamped to Plan, never a bypass.
  const tapBuild = async () => {
    if (actAllowed) {
      switchMode("auto");
      return;
    }
    const ok = window.confirm(
      `Build mode lets ${assistantName} actually DO things for you: create and edit files and run build commands, so she can build what you plan instead of only suggesting.\n\nShe stays inside strict safety rails: she can only write inside her own work folder plus your Desktop and Downloads, she cannot touch your passwords or keys, and anything risky still stops and asks you first.\n\nTurn Build mode on?`
    );
    if (!ok) return;
    try {
      const r = await fetch("/api/builder-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.on) {
        setActAllowed(true);
        switchMode("auto");
      }
    } catch {
      /* stay in Plan — the Vidi Helper menu toggle is the fallback */
    }
  };
  const buildNote = (
    <div className="mode-note">
      {assistantName}{" "}can create and edit files and run safe build commands
      in your workspace, Desktop, and Downloads. Anything risky still stops and
      asks you first, and everything shows up in the Journal.
    </div>
  );
  const modeRow = (
    <div className="picker-row">
      <label>Mode</label>
      <div className="mode-toggle">
        <button
          className={mode === "plan" ? "on" : ""}
          disabled={streaming}
          onClick={() => switchMode("plan")}
        >
          Plan
        </button>
        <button
          className={mode === "auto" ? "on act" : ""}
          disabled={streaming || provider !== "claude"}
          title={provider !== "claude" ? "Build mode needs Claude" : undefined}
          onClick={isCustomer ? tapBuild : () => switchMode("auto")}
        >
          {isCustomer ? "Build" : "Auto"}
        </button>
      </div>
      {mode === "plan" ? (
        planNote
      ) : isCustomer ? (
        buildNote
      ) : (
        <div className="mode-note">
          {assistantName}{" "}can edit files &amp; run safe commands in your
          workspace folder. Everything is listed in the Journal.
        </div>
      )}
    </div>
  );
  const effortRow = (
    <div className="picker-row">
      <label>
        Effort: <span className="effort-value">{EFFORTS[effortIndex].name}</span>
      </label>
      <div
        className={`effort-slider ${effortDisabledReason ? "disabled" : ""}`}
        title={effortDisabledReason ?? undefined}
      >
        <span className="effort-end">Faster</span>
        <input
          type="range"
          min={0}
          max={EFFORTS.length - 1}
          step={1}
          value={effortIndex}
          disabled={streaming || effortDisabledReason !== null}
          aria-label="Reasoning effort"
          aria-valuetext={EFFORTS[effortIndex].name}
          onChange={(e) => switchEffort(EFFORTS[Number(e.target.value)].id)}
          style={{
            ["--effort-fill" as string]: `${(effortIndex / (EFFORTS.length - 1)) * 100}%`,
          }}
        />
        <span className="effort-end">Smarter</span>
      </div>
      <div className="effort-ticks" aria-hidden="true">
        {EFFORTS.map((e, i) => (
          <button
            key={e.id}
            type="button"
            className={`effort-tick ${i === effortIndex ? "on" : ""}`}
            disabled={streaming || effortDisabledReason !== null}
            onClick={() => switchEffort(e.id)}
            tabIndex={-1}
          >
            {e.tick}
          </button>
        ))}
      </div>
      {effortDisabledReason && (
        <div className="mode-note effort-note">{effortDisabledReason}</div>
      )}
    </div>
  );
  const advancedRows = (
    <>
      {providerRow}
      {accountRow}
      {modelRow}
      {providerNote}
      {effortRow}
    </>
  );
  const controlPopover = (
    <div className="orbit-controls-pop" onClick={(e) => e.stopPropagation()}>
      {advancedFlat ? (
        <>
          {providerRow}
          {accountRow}
          {modelRow}
          {providerNote}
          {modeRow}
          {effortRow}
        </>
      ) : (
        <>
          {modeRow}
          <div className="orbit-advanced">
            <button
              type="button"
              className="orbit-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((o) => !o)}
            >
              <span>Advanced</span>
              <span className="orbit-advanced-caret" aria-hidden="true">
                {advancedOpen ? "▾" : "▸"}
              </span>
            </button>
            {advancedOpen && <div className="orbit-advanced-body">{advancedRows}</div>}
          </div>
        </>
      )}
    </div>
  );

  // Home context ribbon — real state only, empty segments omitted (handoff §9).
  // Recent conversation (most-recent thread), Active work (fleet/swarm in motion
  // or a PR waiting on approval; owner-gated with Work), and Memory as its entry.
  const recentThread = threads[0] || null;
  const workSegment =
    showFleet && attention.length
      ? {
          title: `${attention[0].repo} · PR waiting`,
          sub: "Needs your approve",
        }
      : showFleet && busyCount > 0
        ? {
            title: busyCount === 1 ? "1 run in motion" : `${busyCount} runs in motion`,
            sub: "On the Fleet ledger",
          }
        : null;
  const homeRibbon = (
    <div className="vc-ribbon" role="list" aria-label="Resume">
      {recentThread && (
        <button
          type="button"
          role="listitem"
          className="vc-ribbon-seg"
          onClick={() => openThread(recentThread.id)}
          aria-label={`Recent conversation: ${recentThread.title}`}
        >
          <span className="vc-ribbon-ico" aria-hidden="true">
            <RibbonIcon kind="recent" />
          </span>
          <span className="vc-ribbon-copy">
            <span className="vc-ribbon-kicker">Recent conversation</span>
            <span className="vc-ribbon-title">{recentThread.title}</span>
            <span className="vc-ribbon-sub">
              {streams[recentThread.id] || recentThread.running
                ? "Working now"
                : `${relTime(recentThread.updatedAt)} ago`}
            </span>
          </span>
        </button>
      )}
      {workSegment && (
        <Link
          role="listitem"
          className="vc-ribbon-seg"
          href="/canvas"
          aria-label={`Active work: ${workSegment.title}`}
        >
          <span className="vc-ribbon-ico" aria-hidden="true">
            <RibbonIcon kind="work" />
          </span>
          <span className="vc-ribbon-copy">
            <span className="vc-ribbon-kicker">Active work</span>
            <span className="vc-ribbon-title">{workSegment.title}</span>
            <span className="vc-ribbon-sub">{workSegment.sub}</span>
          </span>
        </Link>
      )}
      <Link
        role="listitem"
        className="vc-ribbon-seg"
        href="/memory"
        aria-label="Memory: saved context"
      >
        <span className="vc-ribbon-ico" aria-hidden="true">
          <RibbonIcon kind="memory" />
        </span>
        <span className="vc-ribbon-copy">
          <span className="vc-ribbon-kicker">Memory</span>
          <span className="vc-ribbon-title">Saved context</span>
          <span className="vc-ribbon-sub">View, correct, or forget</span>
        </span>
      </Link>
    </div>
  );

  return (
    <div className="app vc-app">
      <PauseControl />
      <UpdateBanner
        onOpen={() => {
          setSettingsTab("updates");
          setSettingsOpen(true);
        }}
      />
      {onboarded === false && !introChatActive && (
        <Onboarding
          personalities={personalities}
          ownerInstall={ownerInstall}
          onDone={(name) => {
            setDisplayName(name);
            setOnboarded(true);
            // Fresh install finishing the flow drops straight into the intro
            // chat (T2.2) — a conversational first session, not the empty
            // main view.
            setIntroChatActive(true);
            // ...and once THAT closes, the one-time spotlight tour points at
            // the real composer/mic/settings (never again after).
            pendingTourRef.current = true;
          }}
        />
      )}
      {introChatActive && (
        <IntroChat
          onDone={() => {
            setIntroChatActive(false);
            // Re-read the display name so the greeting updates without a reload.
            fetch("/api/onboarding")
              .then((r) => r.json())
              .then((j) => {
                if (j.displayName) setDisplayName(j.displayName);
              })
              .catch(() => {});
            refreshThreads();
            if (pendingTourRef.current) {
              pendingTourRef.current = false;
              let seen = false;
              try {
                seen = localStorage.getItem(TOUR_DONE_KEY) === "1";
              } catch {
                /* private mode: show it; it's skippable */
              }
              if (!seen) setTourOpen(true);
            }
          }}
        />
      )}
      {tourOpen && (
        <SpotlightTour personaName={assistantName} onClose={() => setTourOpen(false)} />
      )}
      {replayIntro && (
        <Onboarding
          personalities={personalities}
          ownerInstall={ownerInstall}
          replay
          onDone={() => setReplayIntro(false)}
        />
      )}
      {scopedStep && (
        <Onboarding
          personalities={personalities}
          ownerInstall={ownerInstall}
          scopedStep={scopedStep}
          onDone={(name) => {
            setScopedStep(null);
            // A completed "name" step wrote displayName — reflect it in the
            // greeting without a reload.
            setDisplayName(name);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          initialTab={settingsTab}
          onReplayIntro={() => {
            // Close settings and re-show the intro as a read-only replay.
            setSettingsOpen(false);
            setReplayIntro(true);
          }}
          onIntroChat={() => {
            // Customer ruling 2026-07-12: from Settings this lands you in the
            // ordinary home chat with the persona, never back in an
            // onboarding-style overlay.
            setSettingsOpen(false);
            backToRooms();
            requestAnimationFrame(() => taRef.current?.focus());
          }}
          onCompleteStep={(step) => {
            // FW3 — deep-link the deferred item into onboarding at its step in a
            // completing scoped mode; finishing it persists + clears the item.
            setSettingsOpen(false);
            setScopedStep(step);
          }}
          onFeedback={() => {
            setSettingsOpen(false);
            setFeedbackPrefill("");
            setFeedbackOpen(true);
          }}
          onClose={() => {
            setSettingsOpen(false);
            // The display name may have changed — re-read it so the greeting
            // updates without a reload.
            fetch("/api/onboarding")
              .then((r) => r.json())
              .then((j) => {
                if (j.displayName) setDisplayName(j.displayName);
              })
              .catch(() => {
                /* keep the current name; a reload will pick up the change */
              });
          }}
        />
      )}
      {feedbackOpen && (
        <FeedbackCompose
          prefill={feedbackPrefill}
          onOpenSettings={() => {
            setFeedbackOpen(false);
            setSettingsOpen(true);
          }}
          onClose={() => {
            setFeedbackOpen(false);
            setFeedbackPrefill("");
          }}
        />
      )}
      {stopConfirmOpen && (
        <div className="onb-backdrop" onClick={() => setStopConfirmOpen(false)}>
          <div className="onb-card stop-confirm-card" onClick={(e) => e.stopPropagation()}>
            <p>I&apos;m still working on this. Want me to stop?</p>
            <div className="onb-actions">
              <button className="onb-btn" onClick={() => setStopConfirmOpen(false)}>
                Keep going
              </button>
              <button
                className="onb-btn onb-btn-primary"
                onClick={stopCurrentTurn}
                disabled={stopping}
              >
                Stop
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Mobile: tapping the dimmed backdrop closes the drawer. */}
      {drawerOpen && (
        <div
          className="drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── THREADS drawer (opened from the THREADS tab / sun context) ──── */}
      <aside
        className={`sidebar orbit-drawer ${drawerOpen ? "drawer-open" : ""}`}
        {...(drawerOpen
          ? { role: "dialog", "aria-modal": true, "aria-label": "Threads and settings" }
          : {})}
      >
        <div className="sidebar-top">
          <button
            className="drawer-close"
            title="Close menu"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
          >
            ✕
          </button>
          <button className="new-chat" onClick={newChat}>
            + New chat
          </button>
          {showFleet && attention.length > 0 && (
            <div className="picker-row">
              <label>Swarm</label>
              {attention.map((s) => (
                <Link key={s.repo} href="/canvas" className="swarm-strip">
                  <span className="swarm-strip-repo">{s.repo}</span>
                  {s.visible.map((w) => (
                    <span key={w.branch} className="swarm-strip-worker">
                      <span className={`swarm-status swarm-status-${w.status}`}>
                        {w.status === "pending-approval" ? "approve?" : w.status}
                      </span>
                      {w.name || w.branch.replace("swarm/", "").slice(0, 18)}
                    </span>
                  ))}
                  {s.merged > 0 && (
                    <span className="swarm-strip-merged">{s.merged} merged ✓</span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>

        {threads.length > 0 && <div className="thread-list-header">Recent</div>}
        <div className="thread-list">
          {threads.map((t) => (
            <div
              key={t.id}
              className={`thread-item ${t.id === activeId ? "active" : ""}`}
              onClick={() => openThread(t.id)}
            >
              <span className="thread-title">{t.title}</span>
              {normMode(t.mode) === "auto" && <span className="act-badge">auto</span>}
              <span className="thread-time">
                {streams[t.id] || t.running ? "streaming…" : relTime(t.updatedAt)}
              </span>
              <button
                className="thread-delete"
                title="Delete thread"
                onClick={(e) => deleteThread(t.id, e)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <button className="settings-open-btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <span>runs on your subscription, no API keys</span>
        </div>
      </aside>

      <NavDesk
        active={view === "rooms" ? "rooms" : "threads"}
        onRooms={backToRooms}
        onThreads={() => setDrawerOpen(true)}
        showFleet={showFleet}
        footer={`${displayName || "Your"}${displayName ? "'s" : ""} workspace`}
        onSettings={() => setSettingsOpen(true)}
      />

      <main className="vc-shell" data-view={view}>
        {/* Home has no competing top toolbar (the rail owns navigation); the
            thread view keeps its header for back/title/export. */}
        {view === "thread" && (
          <header className="vc-header">
            <button
              className="vc-back"
              onClick={backToRooms}
              title="Back to Home"
              aria-label="Back to Home"
            >
              ‹
            </button>
            <div className="vc-header-title">
              <span className="micro-label">
                Thread{isVoiceRoom ? " · started by voice" : ""}
              </span>
              <h1>{activeThread?.title || "New conversation"}</h1>
              <div className="vc-header-meta">
                {providerLabel} · {modelLabel}
                {mode === "auto" && <span className="orbit-badge">auto</span>}
                {streaming && <span className="state-pill working">Working</span>}
              </div>
            </div>
            <div className="vc-header-actions">
              {activeId && (
                <a
                  className="vc-btn-quiet"
                  href={`/api/threads/${activeId}/export`}
                  download
                >
                  Export
                </a>
              )}
            </div>
          </header>
        )}

        {view === "rooms" ? (
          <section className="vc-home" aria-label="Home">
            <h1 className="vc-home-heading">What would you like to understand?</h1>
            {!foregroundRoom && (
              <p className="vc-home-sub">
                Ask {assistantName}{" "}anything. She reads your files and remembers
                what matters, then answers.
              </p>
            )}
          </section>
        ) : (
          <>
            {/* ≤1160px: the margin rail collapses into this context strip. */}
            <div className="vc-context-strip">
              <span className="vc-context-chip">{providerLabel} · {modelLabel}</span>
              <span className="vc-context-chip">{mode === "auto" ? "Auto" : "Plan"} · {EFFORTS[effortIndex].name}</span>
              {streamToolLabel && (
                <span className="vc-context-chip live">{streamToolLabel}</span>
              )}
              {isVoiceRoom && <span className="vc-context-chip">Voice room</span>}
            </div>
            <section className="vc-thread-layout">
              <div className="conversation-doc">
                <div className="orbit-thread" ref={threadScrollRef} onScroll={onThreadScroll}>
                  <div className="spine">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div
                    key={i}
                    className="turn turn-user"
                    style={{ animationDelay: `${Math.min(i * 0.05, 0.4)}s` }}
                  >
                    <span className="spine-dot spine-dot-user" />
                    <div className="turn-label turn-label-user">
                      You
                      {isVoiceRoom && (
                        <span
                          className="voice-origin-tag"
                          title={`Transcribed by ${assistantName} Voice`}
                        >
                          Voice note
                        </span>
                      )}
                    </div>
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="msg-user-atts">
                        {m.attachments.map((a) =>
                          a.kind === "image" ? (
                            <img
                              key={a.id}
                              className="msg-att-thumb"
                              src={`/api/attachments?rel=${encodeURIComponent(a.rel)}`}
                              alt={a.name}
                            />
                          ) : (
                            <a
                              key={a.id}
                              className="msg-att-file"
                              href={`/api/attachments?rel=${encodeURIComponent(a.rel)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              📄 {a.name}
                            </a>
                          )
                        )}
                      </div>
                    )}
                    {m.text && <div className="user-bubble">{m.text}</div>}
                  </div>
                ) : (
                  <div
                    key={i}
                    className="turn turn-vidi"
                    style={{ animationDelay: `${Math.min(i * 0.05, 0.4)}s` }}
                  >
                    <span className="spine-dot spine-dot-vidi" />
                    <div className="turn-label turn-label-vidi">
                      {assistantName}
                      <ReasonedPill reasoning={m.reasoning} />
                      {m.stopped && <StoppedPill />}
                    </div>
                    <div className="vidi-prose md">
                      <ReactMarkdown>{m.text}</ReactMarkdown>
                    </div>
                  </div>
                )
              )}
              {activeId && pendingAgentThreads[activeId] && !activeStream && (
                <div className="turn turn-vidi">
                  <span className="spine-dot spine-dot-vidi" />
                  <div className="turn-label turn-label-vidi">{assistantName}</div>
                  <div className="vidi-prose">
                    <span className="thinking">
                      agent working on this in the background,{" "}
                    </span>
                    <Link href="/canvas">watch on Fleet →</Link>
                  </div>
                </div>
              )}
              {(activeStream || activeRunning || reconnectingHere) && (
                <div className="turn turn-vidi">
                  <span className="spine-dot spine-dot-vidi" data-streaming="true" />
                  <div className="turn-label turn-label-vidi">
                    {assistantName}
                    {streamToolLabel ? ` · ${streamToolLabel}` : ""}
                    <ReasonedPill reasoning={activeStream?.reasoning} />
                  </div>
                  <div className="vidi-prose">
                    {activeStream?.text ? (
                      <StreamingText text={activeStream.text} />
                    ) : livePartial ? (
                      <>
                        <span className="md">
                          <ReactMarkdown>{livePartial}</ReactMarkdown>
                        </span>{" "}
                        <span className="thinking">
                          {reconnectingHere
                            ? `${assistantName} is still working, reconnecting…`
                            : "still working, reply lands here when it's done"}
                        </span>
                      </>
                    ) : (
                      <span className="thinking">
                        {activeStream?.toolLine ||
                          (activeStream
                            ? mode === "auto"
                              ? "working"
                              : "reading"
                            : reconnectingHere
                              ? `${assistantName} is still working, reconnecting…`
                              : "still working, reply lands here when it's done")}
                      </span>
                    )}
                  </div>
                </div>
              )}
                    <div ref={bottomRef} />
                  </div>
                </div>
              </div>

              {/* ── Margin rail: system activity stays out of the prose ── */}
              <aside className="context-margin" aria-label="Thread context">
                <section className="context-sheet edge-violet">
                  <span className="micro-label">Grounded in</span>
                  <h3>Room context</h3>
                  <div className="context-kv">
                    <span>Provider</span>
                    <strong>{providerLabel}</strong>
                  </div>
                  <div className="context-kv">
                    <span>Model</span>
                    <strong>{modelLabel}</strong>
                  </div>
                  <div className="context-kv">
                    <span>Mode</span>
                    <strong>{mode === "auto" ? "Auto, can act" : "Plan, read only"}</strong>
                  </div>
                  <div className="context-kv">
                    <span>Effort</span>
                    <strong>{EFFORTS[effortIndex].name}</strong>
                  </div>
                  {isVoiceRoom && (
                    <div className="context-kv">
                      <span>Origin</span>
                      <strong>{assistantName}{" "}Voice</strong>
                    </div>
                  )}
                </section>

                <section className="context-sheet edge-cyan">
                  <span className="micro-label">
                    {activeStream?.tools.length ? "In motion" : "Recent actions"}
                  </span>
                  <h3>Tool activity</h3>
                  {activeStream?.tools.length ? (
                    activeStream.tools.slice(-6).map((t, i, arr) => (
                      <div
                        key={`${i}-${t}`}
                        className={`source-line mono ${i === arr.length - 1 ? "live" : ""}`}
                      >
                        {t}
                      </div>
                    ))
                  ) : threadJournal.length > 0 ? (
                    threadJournal.slice(-5).map((e, i) => (
                      <div key={i} className="source-line mono">
                        {e.tool} · {e.summary.slice(0, 90)}
                      </div>
                    ))
                  ) : (
                    <p>No tool activity in this room yet. Actions land here as they run.</p>
                  )}
                </section>

                {threads.filter((t) => t.id !== activeId).length > 0 && (
                  <section className="thread-jump">
                    <span className="micro-label">Nearby rooms</span>
                    <h3>Open another portal</h3>
                    {threads
                      .filter((t) => t.id !== activeId)
                      .slice(0, 3)
                      .map((t) => (
                        <button
                          key={t.id}
                          className="jump-room"
                          onClick={() => openThread(t.id)}
                        >
                          <span className="jump-title">{t.title}</span>
                          <span>
                            {streams[t.id] || t.running ? "live" : relTime(t.updatedAt)}
                          </span>
                        </button>
                      ))}
                  </section>
                )}
              </aside>
            </section>
          </>
        )}

        {error && <div className="error-banner">{error}</div>}

        <ConfirmCard />

        {(micState !== "idle" || voiceInterim || voiceLine !== null) && (
          <div className="voice-banner">
            <span className={`voice-dot ${micState}`} />
            <div className="voice-text">
              {micState === "listening"
                ? voiceInterim || "listening…"
                : micState === "thinking"
                  ? voiceLine || `${assistantName} is thinking…`
                  : voiceLine}
            </div>
            {micState === "idle" && !!voiceLine && (
              <button
                className="voice-ctl"
                title={`Replay ${assistantName}'s last reply`}
                onClick={replayVoice}
              >
                ▶
              </button>
            )}
            <button
              className="voice-ctl"
              title={speakOn ? `${assistantName} speaks replies, click to mute` : `Muted, click so ${assistantName} speaks`}
              onClick={toggleSpeak}
            >
              {speakOn ? "🔊" : "🔇"}
            </button>
            <button
              className="voice-ctl"
              title="Dismiss"
              onClick={() => {
                setVoiceLine(null);
                setVoiceInterim("");
                clearAudio();
              }}
            >
              ✕
            </button>
          </div>
        )}

        {queuedDraft && queuedDraft.streamKey === (activeId ?? "__new__") && (
          <div className="queued-banner">
            <span>
              Queued. I&apos;ll ask this once {assistantName}{" "}is done:{" "}
              <strong>
                {queuedDraft.message
                  ? queuedDraft.message.length > 80
                    ? `${queuedDraft.message.slice(0, 80)}…`
                    : queuedDraft.message
                  : `${queuedDraft.attCount} file${queuedDraft.attCount === 1 ? "" : "s"}`}
              </strong>
            </span>
          </div>
        )}

        {/* W5 — the composer is parked while a full-screen onboarding surface
            owns the screen and has its own input. */}
        {!onboardingOverlayActive && (
          <div className="orbit-composer-wrap">
            {feedbackOffer && (
              <div className="feedback-offer">
                <span>
                  That's happened a few times. Want to send the owner a quick report
                  so they can look into it?
                </span>
                <div className="feedback-offer-actions">
                  <button
                    className="feedback-offer-send"
                    onClick={() => {
                      setFeedbackOffer(false);
                      setFeedbackPrefill("");
                      setFeedbackOpen(true);
                    }}
                  >
                    Send a report
                  </button>
                  <button className="feedback-offer-dismiss" onClick={() => setFeedbackOffer(false)}>
                    Not now
                  </button>
                </div>
              </div>
            )}
            {(() => {
              // Chat-native intent: a "tell the owner …" / "send feedback …" draft
              // surfaces a chip that opens the compose-with-preview flow prefilled.
              // It NEVER sends from chat — compose is the only send surface.
              const intent = matchFeedbackIntent(input);
              if (!intent) return null;
              return (
                <button
                  className="feedback-intent-chip"
                  onClick={() => {
                    setFeedbackPrefill(intent.body);
                    setFeedbackOpen(true);
                    setInput("");
                    resetComposerHeight();
                  }}
                >
                  Send this to the owner as feedback
                </button>
              );
            })()}
            {atts.length > 0 && (
              <div className="attach-chips">
                {atts.map((a) => (
                  <div
                    key={a.localId}
                    className={`attach-chip ${a.status}`}
                    title={a.status === "error" ? a.error || "upload failed" : a.name}
                  >
                    {a.kind === "image" && a.previewUrl ? (
                      <img className="attach-chip-thumb" src={a.previewUrl} alt="" />
                    ) : (
                      <span className="attach-chip-icon">📄</span>
                    )}
                    <span className="attach-chip-name">{a.name}</span>
                    {a.status === "uploading" && <span className="attach-chip-spin" />}
                    <button
                      className="attach-chip-remove"
                      title="Remove"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => removeAtt(a.localId)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div
              className={`orbit-composer ${dragOver ? "drag-over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
              }}
            >
              <div className="orbit-controls" ref={controlsWrapRef}>
                {controlsOpen && controlPopover}
                <button
                  className={`orbit-icon-btn ${controlsOpen ? "active" : ""}`}
                  title="Provider, model, mode & effort"
                  aria-label="Provider, model, mode and effort controls"
                  aria-expanded={controlsOpen}
                  onClick={() => setControlsOpen((o) => !o)}
                >
                  ⚙
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.csv,.json,.log,.rtf,.yml,.yaml,.ts,.tsx,.js,.jsx,.py,.sh,.html,.css"
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files?.length) uploadFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                className="orbit-icon-btn"
                title="Attach images or files"
                aria-label="Attach images or files"
                onClick={() => fileRef.current?.click()}
              >
                📎
              </button>
              <textarea
                ref={taRef}
                rows={1}
                data-tour="composer"
                placeholder={
                  view === "rooms"
                    ? `Ask ${assistantName} anything…`
                    : streaming
                      ? "Ask something else. I'll queue it until she's done…"
                      : `Reply${activeThread ? ` in ${activeThread.title}` : ` to ${assistantName}`}…`
                }
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  growComposer(e.target);
                }}
                onPaste={(e) => {
                  if (e.clipboardData.files.length) uploadFiles(e.clipboardData.files);
                }}
                onKeyDown={onKeyDown}
              />
              {micSupported && (
                <button
                  className={`orbit-icon-btn ${micState === "listening" ? "active" : ""}`}
                  data-tour="mic"
                  title={
                    micState === "listening"
                      ? "Listening, tap to finish"
                      : micState === "thinking"
                        ? `${assistantName} is answering…`
                        : `Talk to ${assistantName}`
                  }
                  onClick={toggleMic}
                  disabled={micState === "thinking"}
                >
                  <VoiceBars listening={micState === "listening"} />
                </button>
              )}
              <button
                className={`orbit-send ${streaming ? "stop" : ""}`}
                title={streaming ? "Stop" : "Send"}
                aria-label={streaming ? "Stop" : "Send"}
                onClick={streaming ? () => setStopConfirmOpen(true) : send}
                disabled={
                  streaming
                    ? false
                    : atts.some((a) => a.status === "uploading") ||
                      (!input.trim() && !atts.some((a) => a.status === "ready"))
                }
              >
                {streaming ? (
                  <span
                    style={{
                      width: 13,
                      height: 13,
                      background: "currentColor",
                      borderRadius: 3,
                    }}
                  />
                ) : (
                  <SendArrow />
                )}
              </button>
            </div>
          </div>
        )}
        {view === "rooms" && !onboardingOverlayActive && homeRibbon}
        <BottomNav
          active={view === "rooms" ? "rooms" : "threads"}
          onRooms={backToRooms}
          onThreads={() => setDrawerOpen(true)}
          showFleet={showFleet}
        />
      </main>
    </div>
  );
}
