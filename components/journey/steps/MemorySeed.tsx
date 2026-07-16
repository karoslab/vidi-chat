"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePersonaName } from "@/components/usePersonaName";
import WorkingGlow from "@/components/WorkingGlow";

interface Question {
  id: string;
  prompt: string;
}

/**
 * Stage 3 seed interview (the "5 minute" questions) — the rich screen for the
 * "memory-interview" journey step.
 *
 * Rendered by the journey registry (components/journey/StepScreen.tsx,
 * RICH_ACTIONS["memory-interview"]) as the `action` content of this step's
 * <StepFrame>.
 *
 * `onDone` is the real hook this component drives: call it once the notes are
 * built (or the customer skips), so the caller (StepFrame's onRecheck)
 * re-verifies / moves on.
 *
 * Mechanics reused from components/IntroChat.tsx: a focused card, one question
 * at a time, the customer types an answer. Unlike IntroChat this is a fixed,
 * deterministic script (no model call per question) — the one model call
 * happens server-side at the end, on the cheap worker tier, to distill the
 * answers into notes.
 */
export interface MemorySeedProps {
  /** Called once the interview is built and saved, or when the customer skips. */
  onDone: () => void;
  /** Optional heading, shown only when there is no wrapping StepFrame title. */
  title?: string;
}

export default function MemorySeed({ onDone, title }: MemorySeedProps) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const monogram = (usePersonaName()[0] || "V").toUpperCase();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/journey/memory/interview")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setQuestions(Array.isArray(j.questions) ? j.questions : []);
      })
      .catch(() => {
        if (!cancelled) setError("I could not load the questions. Try again in a moment.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [index, result]);

  const current = questions[index];
  const answeredSoFar = questions.slice(0, index);

  const submitAll = useCallback(
    async (finalAnswers: Record<string, string>) => {
      setBuilding(true);
      setError(null);
      try {
        const r = await fetch("/api/journey/memory/interview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: finalAnswers }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || "Something went wrong.");
        setResult(`I saved ${j.written} notes from your answers.`);
      } catch (e: any) {
        setError(e?.message || "I could not build your notes just now.");
      } finally {
        setBuilding(false);
      }
    },
    []
  );

  const next = useCallback(() => {
    if (!current) return;
    const answer = input.trim();
    const merged = answer ? { ...answers, [current.id]: answer } : { ...answers };
    setAnswers(merged);
    setInput("");
    if (index + 1 < questions.length) {
      setIndex(index + 1);
    } else {
      void submitAll(merged);
    }
  }, [current, input, answers, index, questions.length, submitAll]);

  return (
    <div className="vcstep-seed">
      {title && <h2 className="vcstep-seed-title">{title}</h2>}

      <div className="intro-messages">
        {answeredSoFar.map((q) => (
          <div className="vcstep-seed-pair" key={q.id}>
            <div className="msg-vidi">
              <div className="mini-monogram">{monogram}</div>
              <div className="msg-vidi-body">{q.prompt}</div>
            </div>
            {answers[q.id] && <div className="msg-user">{answers[q.id]}</div>}
          </div>
        ))}

        {!result && current && (
          <div className="msg-vidi">
            <div className="mini-monogram">{monogram}</div>
            <div className="msg-vidi-body">{current.prompt}</div>
          </div>
        )}

        {building && (
          <div className="msg-vidi">
            <div className="mini-monogram">{monogram}</div>
            <div className="msg-vidi-body">
              <WorkingGlow
                compact
                lines={[
                  "Reading your answers…",
                  "Writing your first memory notes…",
                  "Filing them where I can always find them…",
                ]}
              />
            </div>
          </div>
        )}

        {result && (
          <div className="msg-vidi">
            <div className="mini-monogram">{monogram}</div>
            <div className="msg-vidi-body">{result}</div>
          </div>
        )}

        {error && <div className="onb-error">{error}</div>}
        <div ref={bottomRef} />
      </div>

      {result ? (
        <div className="intro-composer">
          <button className="onb-btn onb-btn-primary" onClick={onDone}>
            Done
          </button>
        </div>
      ) : (
        <div className="intro-composer">
          <input
            className="onb-input"
            autoFocus
            value={input}
            placeholder="Type your answer…"
            disabled={building || !current}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") next();
            }}
          />
          <button className="onb-btn onb-btn-primary" disabled={building || !current} onClick={next}>
            {current && index + 1 >= questions.length ? "Build my memory" : "Next"}
          </button>
          <button className="onb-btn onb-btn-skip" onClick={onDone}>
            Skip for now
          </button>
        </div>
      )}
    </div>
  );
}
