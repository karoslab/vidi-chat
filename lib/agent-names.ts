/**
 * Curated agent-name stacks (P4.2). When a user spawns an agent she can name
 * it — free-text, or pick from these stacks. Names persist via agents.json
 * (the fleet manager already stores agent.name) and are used everywhere the
 * agent is shown.
 *
 * The Kannada / Indian-mythology stack is rendered with CRAFT, per the owner's
 * explicit no-slop rule: the Kannada letters are the hero (correct spelling,
 * never distorted or decorative-only), each carries a Roman transliteration for
 * addressing/STT and a one-line meaning. This is a picker + persistence, not a
 * theming engine.
 */

export interface CuratedName {
  /** The value stored as the agent's callsign (Roman, so voice + STT can address it). */
  name: string;
  /** Kannada script when this is a Kannada/Indian name — shown as the hero, undistorted. */
  script?: string;
  /** One-line meaning / who they are. */
  meaning: string;
}

export interface NameStack {
  id: string;
  label: string;
  names: CuratedName[];
}

export const NAME_STACKS: NameStack[] = [
  {
    id: "scifi",
    label: "Sci-fi & TV assistants",
    names: [
      { name: "Jarvis", meaning: "Iron Man's ever-ready AI butler." },
      { name: "HAL", meaning: "The calm ship's computer of 2001." },
      { name: "Data", meaning: "Star Trek's android who wants to be more human." },
      { name: "TARS", meaning: "Interstellar's witty, loyal robot." },
      { name: "Cortana", meaning: "Halo's guiding AI companion." },
      { name: "Samantha", meaning: "The warm voice-OS from Her." },
      { name: "Friday", meaning: "Stark's successor assistant to Jarvis." },
      { name: "KITT", meaning: "Knight Rider's talking car." },
    ],
  },
  {
    id: "movies",
    label: "Movie characters",
    names: [
      { name: "Neo", meaning: "The Matrix's chosen one." },
      { name: "Ripley", meaning: "Alien's relentless survivor." },
      { name: "Gandalf", meaning: "The wise wandering guide." },
      { name: "Yoda", meaning: "The small, patient master." },
      { name: "Trinity", meaning: "The Matrix's fearless operator." },
      { name: "Dory", meaning: "Finding Nemo's ever-hopeful helper." },
      { name: "Wall-E", meaning: "The tireless little cleanup robot." },
      { name: "Baymax", meaning: "Big Hero 6's gentle care companion." },
    ],
  },
  {
    id: "greek",
    label: "Greek & Norse myth",
    names: [
      { name: "Athena", meaning: "Greek goddess of wisdom and craft." },
      { name: "Atlas", meaning: "The titan who bears the heavens." },
      { name: "Hermes", meaning: "The swift messenger of the gods." },
      { name: "Odin", meaning: "The Norse all-father who traded an eye for wisdom." },
      { name: "Freya", meaning: "Norse goddess of love and foresight." },
      { name: "Iris", meaning: "Goddess of the rainbow, messenger between worlds." },
    ],
  },
  {
    // Kannada / Indian mythology — the hero stack, rendered with respect.
    // Kannada script is the undistorted lead; Roman name is for addressing.
    id: "kannada",
    label: "Kannada & Indian mythology",
    names: [
      { name: "Garuda", script: "ಗರುಡ", meaning: "The mighty eagle who carries Vishnu — swift and fearless." },
      { name: "Hanuma", script: "ಹನುಮ", meaning: "Hanuman — devotion, strength, and a leap across the sea." },
      { name: "Saraswati", script: "ಸರಸ್ವತಿ", meaning: "Goddess of knowledge, music, and learning." },
      { name: "Mithra", script: "ಮಿತ್ರ", meaning: "Friend — the light of friendship and the sun." },
      { name: "Ashwini", script: "ಅಶ್ವಿನಿ", meaning: "The twin healers, swift as horses; the first star." },
      { name: "Ganapa", script: "ಗಣಪ", meaning: "Ganesha — remover of obstacles, patron of beginnings." },
      { name: "Chandra", script: "ಚಂದ್ರ", meaning: "The moon — calm, steady, ever-returning." },
      { name: "Varuna", script: "ವರುಣ", meaning: "Keeper of the waters and cosmic order." },
      { name: "Surya", script: "ಸೂರ್ಯ", meaning: "The sun — light, energy, and the day's beginning." },
      { name: "Aruna", script: "ಅರುಣ", meaning: "The dawn's charioteer — the first glow of morning." },
    ],
  },
];

/** Flat set of all curated Roman names, lowercased — for validation/dedupe. */
export function allCuratedNames(): string[] {
  return NAME_STACKS.flatMap((stack) => stack.names.map((entry) => entry.name));
}

/**
 * The DEFAULT stack a user's helpers draw their names from when she hasn't
 * picked one — the Kannada / Indian-mythology stack, the hero set (the owner's
 * ruling: it's the default, pickable in onboarding and the Canvas picker).
 */
export const DEFAULT_AGENT_NAME_STACK_ID = "kannada";

/** True when `value` is the id of a real curated stack. Used to validate the
 *  stored `agentNameStack` preference — anything else is rejected on write and
 *  ignored (falls back to the default) on read. */
export function isNameStackId(value: unknown): boolean {
  return typeof value === "string" && NAME_STACKS.some((stack) => stack.id === value);
}

/** The stack with the given id, or the default stack when the id is unknown
 *  (so a stale/invalid stored value never yields "no names to draw from"). */
export function nameStackByIdOrDefault(stackId: string | null | undefined): NameStack {
  const found = NAME_STACKS.find((stack) => stack.id === stackId);
  if (found) return found;
  return NAME_STACKS.find((stack) => stack.id === DEFAULT_AGENT_NAME_STACK_ID)!;
}
