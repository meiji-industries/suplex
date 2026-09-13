import { resolveClaudeExecutable, resolveDevinExecutable } from "../platform/executable-resolver.js";
import type { ProviderListResponse } from "../http/contracts/providers.js";
import { readOpenCodeProviders } from "../runtimes/opencode/providers.js";
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER, DEVIN_MODELS, DEVIN_PROVIDER } from "../runtimes/task-harness.js";

export type ReadProviders = () => Promise<ProviderListResponse>;

/** OpenCode providers plus local agent CLIs. Neither observation sends a model request. */
export async function readProviders(input: { directory: string }): Promise<ProviderListResponse> {
  const cliProviders = await Promise.all([
    { resolve: resolveClaudeExecutable, id: CLAUDE_CODE_PROVIDER, label: "Claude Code", models: CLAUDE_CODE_MODELS },
    { resolve: resolveDevinExecutable, id: DEVIN_PROVIDER, label: "Devin CLI", models: DEVIN_MODELS },
  ].map(async provider => {
    const status = await provider.resolve().then(() => "configured" as const, () => "missing" as const);
    return { id: provider.id, label: provider.label, modelCount: provider.models.length, models: provider.models, status };
  }));
  const configured = cliProviders.flat();
  let native: ProviderListResponse;
  try { native = await readOpenCodeProviders(input); }
  catch {
    native = { directory: input.directory, observedAt: new Date().toISOString(), providers: [] };
  }
  return { ...native, providers: [...native.providers, ...configured].sort((a, b) => a.label.localeCompare(b.label)) };
}
