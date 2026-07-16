"use client";

import { useCallback, useState } from "react";
import { ASSISTANT_MONOGRAM } from "@/lib/assistant-identity";

/**
 * Stage 3 "bring your stuff" (optional) — the rich screen for the
 * "memory-bring-stuff" journey step. The customer types the full path to ONE
 * folder they already keep notes in, and Vidi turns the text files in it into
 * linked notes.
 *
 * There is deliberately NO folder browser and NO scanning here: the customer
 * names a folder on purpose, and the server refuses anything private or outside
 * their home folder, reads only a bounded number of text files, and never looks
 * anywhere they did not point it.
 *
 * Rendered by the journey registry (components/journey/StepScreen.tsx,
 * RICH_ACTIONS["memory-bring-stuff"]) as the `action` content of this step's
 * <StepFrame>.
 *
 * `onDone` is the real hook this component drives: call it once a folder is
 * brought in (or the customer skips), since this step is optional and always
 * verifies true — onDone just moves the customer on.
 */
export interface MemoryBringStuffProps {
  onDone: () => void;
  /** Optional heading, shown only when there is no wrapping StepFrame title. */
  title?: string;
}

export default function MemoryBringStuff({ onDone, title }: MemoryBringStuffProps) {
  const [path, setPath] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const monogram = ASSISTANT_MONOGRAM;

  const bringIn = useCallback(async () => {
    const folder = path.trim();
    if (!folder || working) return;
    setWorking(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch("/api/journey/memory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folder }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "I could not bring in that folder.");
      setResult(
        `I read ${j.filesRead} file(s) and saved ${j.written} notes. ` +
          (j.filesSkipped ? `I skipped ${j.filesSkipped} that were not plain text or were too big.` : "")
      );
    } catch (e: any) {
      setError(e?.message || "I could not bring in that folder just now.");
    } finally {
      setWorking(false);
    }
  }, [path, working]);

  return (
    <div className="vcstep-seed">
      {title && <h2 className="vcstep-seed-title">{title}</h2>}

      <div className="intro-messages">
        <div className="msg-vidi">
          <div className="mini-monogram">{monogram}</div>
          <div className="msg-vidi-body">
            If you already keep notes in a folder, tell me where it is and I will add them
            to your memory. I only read the folder you name, and I skip anything private.
            This is optional. You can do it now or any time later.
          </div>
        </div>

        {working && (
          <div className="msg-vidi">
            <div className="mini-monogram">{monogram}</div>
            <div className="msg-vidi-body">
              <span className="thinking">reading your folder…</span>
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
            value={path}
            placeholder="~/Documents/my-notes"
            disabled={working}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && path.trim()) bringIn();
            }}
          />
          <button className="onb-btn onb-btn-primary" disabled={working || !path.trim()} onClick={bringIn}>
            Bring it in
          </button>
          <button className="onb-btn onb-btn-skip" onClick={onDone}>
            Skip for now
          </button>
        </div>
      )}
    </div>
  );
}
