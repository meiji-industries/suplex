import { resolveClaudeExecutable } from "./executable-resolver.js";
import type { ProviderListResponse } from "./http/contracts/providers.js";
import { readOpenCodeProviders } from "./opencode-providers.js";
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER } from "./task-harness.js";

export type ReadProviders = () => Promise<ProviderListResponse>;

/** OpenCode providers plus Claude Code when its CLI is installed. Neither observation sends a model request. */
export async function readProviders(input: { directory: string }): Promise<ProviderListResponse> {
  const claude = await resolveClaudeExecutable().then(() => [{ id: CLAUDE_CODE_PROVIDER, label: "Claude Code", modelCount: CLAUDE_CODE_MODELS.length, models: CLAUDE_CODE_MODELS, status: "configured" as const }], () => []);
  let native: ProviderListResponse;
  try { native = await readOpenCodeProviders(input); }
  catch (error) {
    if (!claude.length) throw error;
    native = { directory: input.directory, observedAt: new Date().toISOString(), providers: [] };
  }
  return { ...native, providers: [...native.providers, ...claude].sort((a, b) => a.label.localeCompare(b.label)) };
}
