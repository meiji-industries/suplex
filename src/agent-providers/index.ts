import { herdrClaudeProvider } from "./herdr-claude.js";
import { herdrCodexProvider } from "./herdr-codex.js";
import type { AgentProvider, AgentProviderKind } from "./provider.js";

export const agentProviders = { codex: herdrCodexProvider, claude: herdrClaudeProvider } as const satisfies Record<AgentProviderKind, AgentProvider>;

export function resolveAgentProvider(provider: AgentProviderKind = "codex"): AgentProvider {
  const resolved = agentProviders[provider];
  if (!resolved) throw new Error(`Unknown agent provider: ${provider}`);
  return resolved;
}
