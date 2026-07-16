"use client";

import { useEffect, useState } from "react";

/**
 * The shared "she's working on it" animation (2026-07-12 customer ask: every
 * waiting page should feel alive, not like a stuck line of text). A breathing
 * coral orb with two orbiting sparks and a status line that keeps moving so
 * the wait reads as progress. Pure CSS motion, reduced-motion safe (the orb
 * stands still, the words still cycle).
 */
export default function WorkingGlow({
  lines,
  compact = false,
}: {
  /** Status phrases, cycled in order and held on the last one. */
  lines: string[];
  /** Tighter spacing for inline use (chat bubbles, small panels). */
  compact?: boolean;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(
      () => setI((n) => (n + 1 < lines.length ? n + 1 : n)),
      2400
    );
    return () => clearInterval(t);
  }, [lines.length]);

  return (
    <div className={`vc-working ${compact ? "vc-working-compact" : ""}`} role="status">
      <span className="vc-working-orb" aria-hidden="true">
        <span className="vc-working-spark" />
        <span className="vc-working-spark vc-working-spark-2" />
      </span>
      <span className="vc-working-line" key={i}>
        {lines[i]}
      </span>
    </div>
  );
}
