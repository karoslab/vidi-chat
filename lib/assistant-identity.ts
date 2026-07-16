/**
 * Assistant identity — the single source of truth every surface imports.
 *
 * Vidi's identity is FIXED (product ruling 2026-07-05: "Vidi is her name and
 * Vidi is who she is going to be"). It is NOT user-editable: the name is always
 * "Vidi" and the monogram is always "V". This constant is the one place that
 * knows that, so headers, greetings, and avatar monograms all read it instead
 * of hardcoding the letter.
 *
 * Pure and client-safe (no node:fs) so client components can import it directly.
 *
 * NOTE: this is the ASSISTANT's identity, distinct from the fleet-agent names a
 * user gives the agents she deploys (lib/agent-names.ts) — those stay editable.
 */

export const ASSISTANT_NAME = "Vidi";
export const ASSISTANT_MONOGRAM = "V";
