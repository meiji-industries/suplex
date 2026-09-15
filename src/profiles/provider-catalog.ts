import { resolveClaudeExecutable, resolveCodexExecutable, resolveDevinExecutable } from "../platform/executable-resolver.js";
import type { ProviderListResponse, ProviderObservation } from "../http/contracts/providers.js";
import { readOpenCodeProviders } from "../runtimes/opencode/providers.js";
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER, CODEX_MODELS, CODEX_PROVIDER, DEVIN_MODELS, DEVIN_PROVIDER } from "../runtimes/task-harness.js";
import type { ProviderConnectionProbe } from "./provider-connection.js";

export type ReadProviders = () => Promise<ProviderListResponse>;

/** OpenCode providers plus local agent CLIs. Neither observation sends a model request. */
export async function readProviders(input: { directory: string; connection?: ProviderConnectionProbe }): Promise<ProviderListResponse> {
  const cliProviders = await Promise.all([
    { resolve: resolveClaudeExecutable, id: CLAUDE_CODE_PROVIDER, label: "Claude Code", models: CLAUDE_CODE_MODELS },
    { resolve: resolveDevinExecutable, id: DEVIN_PROVIDER, label: "Devin CLI", models: DEVIN_MODELS },
    { resolve: resolveCodexExecutable, id: CODEX_PROVIDER, label: "Codex CLI", models: CODEX_MODELS },
  ].map(async provider => {
    const status = await provider.resolve().then(() => "configured" as const, () => "missing" as const);
    return { id: provider.id, label: provider.label, modelCount: provider.models.length, models: provider.models, status };
  }));
  const configured = cliProviders.flat();
  let native: ProviderObservation;
  try { native = await readOpenCodeProviders(input); }
  catch {
    native = { directory: input.directory, observedAt: new Date().toISOString(), providers: [] };
  }
  const probe = input.connection;
  const providers = await Promise.all([...native.providers, ...configured].map(async provider => ({
    ...provider,
    connection: probe ? await probe(provider.id) : { status: "unknown" as const, summary: "Forge did not check the sign-in." },
  })));
  return { ...native, providers: providers.sort((a, b) => a.label.localeCompare(b.label)) };
}
