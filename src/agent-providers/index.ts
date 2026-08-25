import { herdrCodexProvider } from "./herdr-codex.js";
import type { AgentProvider } from "./provider.js";

export const agentProviders = { codex: herdrCodexProvider } as const satisfies Record<string, AgentProvider>;

/**
 * Single resolution point for the active agent provider. Multi-provider
 * routing (per-profile or config-driven selection) is deliberately deferred
 * until a second adapter exists; today the answer is always Codex.
 */
export function resolveAgentProvider(): AgentProvider {
  return agentProviders.codex;
}
