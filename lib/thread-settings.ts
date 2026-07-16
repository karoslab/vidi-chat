import { getProvider } from "./providers/index.ts";

/**
 * Legacy Claude model pin. Not in any provider's `models` list, but the router
 * still accepts it and degrades it to opus+ultracode (lib/models.ts), so old
 * threads pinned to "fable" must stay PATCH-able.
 */
const LEGACY_MODELS = new Set(["fable"]);

/**
 * A thread's model may only be flipped to one its OWN provider actually offers
 * (plus the legacy "fable" pin). PATCH /api/threads/[id] used to check a single
 * static whitelist {auto,fable,opus,sonnet,default}, which 400'd every real
 * grok/codex model id — grok-4.5 and the gpt-5.6-* slugs — so per-thread model
 * switching silently worked for Claude alone (R3 bug).
 */
export function isModelValidForProvider(providerId: string, model: unknown): boolean {
  if (typeof model !== "string") return false;
  if (LEGACY_MODELS.has(model)) return true;
  // Grok's ids are now grok-4.5-build / grok-4.5-chat (FIX 3); the bare
  // "grok-4.5" is the legacy id persisted on older grok threads. Keep it
  // PATCH-able for grok ONLY (the provider coerces it to Build), so a
  // pre-existing grok thread never 400s — without making it valid elsewhere.
  if (providerId === "grok" && model === "grok-4.5") return true;
  const prov = getProvider(providerId);
  return prov ? prov.models.some((m) => m.id === model) : false;
}
