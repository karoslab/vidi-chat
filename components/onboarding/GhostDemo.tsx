"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The onboarding finale's "watch me work" theater (2026-07-12). Instead of
 * telling a non-technical person what to type, a miniature chat plays itself:
 * a starter question types itself into a mock composer, sends, and the reply
 * streams in — then the next pair. Everything is scripted capability copy
 * (nothing pretends to have read their real files), runs entirely
 * client-side, and burns zero tokens. Reduced-motion users get the finished
 * exchange rendered statically.
 */

interface Exchange {
  q: string;
  a: string;
}

const EXCHANGES: Exchange[] = [
  {
    q: "What can you do for me?",
    a: "I read the files you share with me, remember what matters to you, and help you build real things. Nothing big happens without your yes.",
  },
  {
    q: "Remember that my sister's birthday is in May.",
    a: "Kept. Ask me anytime and I'll know.",
  },
  {
    q: "Help me plan a simple website for my idea.",
    a: "Gladly. Tell me the idea in one line and I'll ask a few plain questions, then write up a plan you can follow.",
  },
];

const TYPE_MS = 38; // per character into the composer
const STREAM_MS = 26; // per character of the reply
const HOLD_MS = 2200; // rest on the finished exchange before the next

type Phase = "typing" | "sending" | "streaming" | "holding";

export default function GhostDemo({ personaName }: { personaName: string }) {
  const [reduced, setReduced] = useState(false);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("typing");
  const [typed, setTyped] = useState(0);
  const [streamed, setStreamed] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    setReduced(!!mq?.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    if (reduced) return;
    const ex = EXCHANGES[idx];
    const next = (fn: () => void, ms: number) => {
      timer.current = setTimeout(fn, ms);
    };
    if (phase === "typing") {
      if (typed < ex.q.length) next(() => setTyped((n) => n + 1), TYPE_MS);
      else next(() => setPhase("sending"), 350);
    } else if (phase === "sending") {
      next(() => setPhase("streaming"), 420);
    } else if (phase === "streaming") {
      if (streamed < ex.a.length) next(() => setStreamed((n) => n + 1), STREAM_MS);
      else next(() => setPhase("holding"), 200);
    } else {
      next(() => {
        setIdx((i) => (i + 1) % EXCHANGES.length);
        setTyped(0);
        setStreamed(0);
        setPhase("typing");
      }, HOLD_MS);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reduced, idx, phase, typed, streamed]);

  const ex = EXCHANGES[idx];
  if (reduced) {
    // No motion: the first finished exchange, standing still.
    const first = EXCHANGES[0];
    return (
      <div className="onb-ghost" aria-label={`Example: you ask "${first.q}" and ${personaName} answers.`}>
        <div className="onb-ghost-bubble onb-ghost-you">{first.q}</div>
        <div className="onb-ghost-bubble onb-ghost-vidi">{first.a}</div>
      </div>
    );
  }

  const sent = phase === "streaming" || phase === "holding";
  return (
    <div className="onb-ghost" aria-hidden="true">
      {sent && <div className="onb-ghost-bubble onb-ghost-you">{ex.q}</div>}
      {sent && streamed > 0 && (
        <div className="onb-ghost-bubble onb-ghost-vidi">
          {ex.a.slice(0, streamed)}
          {phase === "streaming" && <span className="onb-ghost-caret" />}
        </div>
      )}
      <div className={`onb-ghost-composer ${phase === "sending" ? "sending" : ""}`}>
        <span className="onb-ghost-input">
          {!sent && (
            <>
              {ex.q.slice(0, typed)}
              {phase === "typing" && <span className="onb-ghost-caret" />}
            </>
          )}
          {!sent && typed === 0 && phase === "typing" && (
            <span className="onb-ghost-placeholder">Ask {personaName} anything…</span>
          )}
        </span>
        <span className={`onb-ghost-send ${phase === "sending" ? "pop" : ""}`} aria-hidden="true">
          ↑
        </span>
      </div>
    </div>
  );
}
