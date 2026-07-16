import type { BrainProvider } from "./types.ts";
import { claudeProvider } from "./claude.ts";
import { codexProvider } from "./codex.ts";
import { grokProvider } from "./grok.ts";

export const providers: Record<string, BrainProvider> = {
  claude: claudeProvider,
  codex: codexProvider,
  grok: grokProvider,
};

export function getProvider(id: string): BrainProvider | null {
  return providers[id] ?? null;
}
