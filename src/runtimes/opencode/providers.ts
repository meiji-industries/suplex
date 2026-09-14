import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenCodeExecutable } from "../../platform/executable-resolver.js";
import { ensureOpenCodeServer, openCodeServerClient, readOpenCodeServer, stopOpenCodeServer } from "./server.js";
import type { ProviderObservation } from "../../http/contracts/providers.js";

// A fresh, session-free server reads current native auth and configuration.
// Disposing it cannot interrupt a task's server or refresh its credentials.
export async function readOpenCodeProviders(input: { directory: string; executable?: string }): Promise<ProviderObservation> {
  const executable = await resolveOpenCodeExecutable(input);
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "forge-provider-observation-"));
  try {
    const reference = await ensureOpenCodeServer({ runtimeDirectory, executable, directory: input.directory, config: {} });
    const native = await openCodeServerClient(reference).providers(reference.directory);
    const connected = new Set(native.connected);
    return {
      directory: reference.directory, observedAt: new Date().toISOString(),
      providers: native.all.filter((provider) => connected.has(provider.id)).map((provider) => ({
        id: provider.id, label: provider.name, modelCount: Object.keys(provider.models).length, status: "configured" as const,
        models: Object.values(provider.models).map((model) => ({ id: model.id, label: model.name })).sort((a, b) => a.label.localeCompare(b.label)),
      })).sort((a, b) => a.label.localeCompare(b.label)),
    };
  } finally {
    const reference = await readOpenCodeServer(runtimeDirectory);
    if (reference) await stopOpenCodeServer(reference);
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}
