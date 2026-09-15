import { resolveClaudeExecutable, resolveCodexExecutable, resolveDevinExecutable, resolveOpenCodeExecutable } from "../platform/executable-resolver.js";
import type { ProviderListResponse, ProviderObservation, ProviderSummary } from "../http/contracts/providers.js";
import { readOpenCodeProviders } from "../runtimes/opencode/providers.js";
import { CLAUDE_CODE_MODELS, CODEX_MODELS, DEVIN_MODELS } from "../runtimes/task-harness.js";
import type { HarnessKind } from "../runtimes/harness-kind.js";
import type { ProviderConnectionProbe } from "./provider-connection.js";

export type ReadProviders = () => Promise<ProviderListResponse>;

/**
 * One row per agent tool. OpenCode's own vendors are folded into its row as
 * vendor-qualified model ids, because Forge selects OpenCode as the harness and
 * names the vendor inside the model. Neither observation sends a model request.
 */
export async function readProviders(input: { directory: string; connection?: ProviderConnectionProbe }): Promise<ProviderListResponse> {
  let native: ProviderObservation;
  try { native = await readOpenCodeProviders(input); }
  catch {
    native = { directory: input.directory, observedAt: new Date().toISOString(), providers: [] };
  }
  const openCodeModels = native.providers.flatMap(vendor => vendor.models.map(model => ({ id: `${vendor.id}/${model.id}`, label: `${model.label} (${vendor.label})` })));
  const rows: { resolve: () => Promise<string>; id: HarnessKind; label: string; models: { id: string; label: string }[] }[] = [
    { resolve: resolveOpenCodeExecutable, id: "opencode", label: "OpenCode", models: openCodeModels },
    { resolve: resolveClaudeExecutable, id: "claude-code", label: "Claude Code", models: CLAUDE_CODE_MODELS },
    { resolve: resolveDevinExecutable, id: "devin", label: "Devin CLI", models: DEVIN_MODELS },
    { resolve: resolveCodexExecutable, id: "codex", label: "Codex CLI", models: CODEX_MODELS },
  ];
  const probe = input.connection;
  const providers: ProviderSummary[] = await Promise.all(rows.map(async row => ({
    id: row.id, label: row.label, modelCount: row.models.length, models: row.models,
    status: await row.resolve().then(() => "configured" as const, () => "missing" as const),
    connection: probe ? await probe(row.id) : { status: "unknown" as const, summary: "Forge did not check the sign-in." },
  })));
  return { ...native, providers: providers.sort((a, b) => a.label.localeCompare(b.label)) };
}
