export const AGENT_PROVIDER_KINDS = ["codex", "claude", "openrouter"] as const;

export type AgentProviderKind = (typeof AGENT_PROVIDER_KINDS)[number];

export type HerdrAgentKind = "codex" | "claude" | "omp";

export const PROVIDER_HARNESSES: Record<AgentProviderKind, {
  harness: HerdrAgentKind;
  label: string;
  harnessLabel: string;
  healthCheckId: "codex-auth" | "claude-auth" | "openrouter-auth";
}> = {
  codex: { harness: "codex", label: "Codex", harnessLabel: "Codex CLI", healthCheckId: "codex-auth" },
  claude: { harness: "claude", label: "Claude Code", harnessLabel: "Claude Code CLI", healthCheckId: "claude-auth" },
  openrouter: { harness: "omp", label: "OpenRouter", harnessLabel: "omp (oh-my-pi)", healthCheckId: "openrouter-auth" },
};
