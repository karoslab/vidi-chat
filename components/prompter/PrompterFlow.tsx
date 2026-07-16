"use client";

import { useEffect, useRef, useState } from "react";
import type { PrompterAnswer, PrompterQuestion } from "@/lib/prompter";

/**
 * PrompterFlow — the guided, one-question-at-a-time intake. The customer can
 * tap concrete choice chips AND type freely on every question (the first one
 * invites a full "throw ideas everywhere" dump). Answers accumulate client-side;
 * each turn asks the server for the next question (worded on the worker tier).
 * When enough is answered, onReady fires with the collected answers so the
 * parent can synthesize the brief.
 */

interface Props {
  /** Optional seed dump to prefill the first free-text box. */
  seedIdea?: string;
  onReady: (answers: PrompterAnswer[]) => void;
  onCancel?: () => void;
}

const jsonPost = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

export default function PrompterFlow({ seedIdea, onReady, onCancel }: Props) {
  const [answers, setAnswers] = useState<PrompterAnswer[]>([]);
  const [question, setQuestion] = useState<PrompterQuestion | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState(seedIdea ?? "");
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);

  // Ask for the first question on mount.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    void loadNext([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadNext(nextAnswers: PrompterAnswer[]) {
    setBusy(true);
    try {
      const res = await jsonPost("/api/prompter/next", { answers: nextAnswers });
      if (res.ready || !res.question) {
        onReady(nextAnswers);
        return;
      }
      setQuestion(res.question as PrompterQuestion);
      setPicked([]);
      setText("");
    } catch {
      // Keep the customer moving even if the wording service hiccups.
      setQuestion(null);
    } finally {
      setBusy(false);
    }
  }

  function toggleChip(chip: string) {
    setPicked((p) => (p.includes(chip) ? p.filter((c) => c !== chip) : [...p, chip]));
  }

  async function submit() {
    if (!question) return;
    const answer: PrompterAnswer = {
      topic: question.topic,
      ...(picked.length ? { chosenChips: picked } : {}),
      ...(text.trim() ? { text: text.trim() } : {}),
    };
    const next = [...answers, answer];
    setAnswers(next);
    await loadNext(next);
  }

  const answered = answers.length;
  const canSkip = Boolean(onCancel);

  return (
    <div className="vcp-flow" style={{ maxWidth: 720, margin: "0 auto" }}>
      <p className="micro-label">Let us plan your idea · question {answered + 1}</p>
      {!question ? (
        <p style={{ opacity: 0.7 }}>{busy ? "One moment…" : "Getting the first question ready…"}</p>
      ) : (
        <div className="vcp-question">
          <h2 style={{ marginTop: 8 }}>{question.question}</h2>

          <div
            className="vcp-chips"
            style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "16px 0" }}
          >
            {question.chips.map((chip) => {
              const on = picked.includes(chip);
              return (
                <button
                  key={chip}
                  type="button"
                  onClick={() => toggleChip(chip)}
                  aria-pressed={on}
                  className="vcp-chip"
                  style={{
                    borderRadius: 999,
                    padding: "8px 14px",
                    border: on ? "2px solid currentColor" : "1px solid rgba(0,0,0,0.2)",
                    background: on ? "rgba(0,0,0,0.06)" : "transparent",
                    cursor: "pointer",
                    fontWeight: on ? 600 : 400,
                  }}
                >
                  {chip}
                </button>
              );
            })}
          </div>

          <label style={{ display: "block" }}>
            <span className="micro-label">Or say it in your own words</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={question.topic === "idea" ? 5 : 3}
              placeholder="Type as much or as little as you like…"
              style={{
                width: "100%",
                marginTop: 6,
                padding: 12,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.2)",
                font: "inherit",
                resize: "vertical",
              }}
            />
          </label>

          <div style={{ display: "flex", gap: 12, marginTop: 16, alignItems: "center" }}>
            <button
              type="button"
              className="vc-btn"
              onClick={submit}
              disabled={busy || (picked.length === 0 && !text.trim())}
              style={{ padding: "10px 20px", borderRadius: 12, cursor: "pointer" }}
            >
              {busy ? "…" : "Next"}
            </button>
            <button
              type="button"
              className="vc-btn-quiet"
              onClick={() => submit()}
              disabled={busy}
              style={{ cursor: "pointer" }}
              title="Skip this one"
            >
              Skip
            </button>
            {canSkip && (
              <button
                type="button"
                className="vc-btn-quiet"
                onClick={onCancel}
                style={{ marginLeft: "auto", cursor: "pointer" }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
