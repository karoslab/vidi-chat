import { getAssistantName } from "./user-config.ts";

/**
 * Persona-name copy pass (2026-07-12). A customized install answers to its
 * own name ("Anna"), and every sentence the product says should use it — the
 * journey step titles/notes, setup health copy, and any other server-authored
 * string. Rather than threading the name through dozens of static step
 * definitions, outgoing copy is personalized once at the API boundary.
 *
 * The BRAND stays "Vidi" only where it names the software itself: the
 * "Vidi Helper" menu-bar app. Everything else is the persona speaking.
 */

export function personaCopy(s: string): string {
  const name = getAssistantName();
  if (!name || name === "Vidi") return s;
  // \b keeps "Vidi's" → "Anna's" working (the ' is a boundary); the negative
  // lookahead protects the Vidi Helper product name.
  return s.replace(/\bVidi\b(?! Helper)/g, name);
}

/** Personalize every string field in a JSON-safe value, recursively. */
export function personaCopyDeep<T>(value: T): T {
  if (typeof value === "string") return personaCopy(value) as unknown as T;
  if (Array.isArray(value)) return value.map(personaCopyDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = personaCopyDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
