export const AGENT_PROVIDER_KINDS = ["codex", "claude", "openrouter"] as const;

export type AgentProviderKind = (typeof AGENT_PROVIDER_KINDS)[number];
export const SERVICE_PRIORITIES = ["standard", "priority", "fast"] as const;

export type ServicePriority = (typeof SERVICE_PRIORITIES)[number];
export type HerdrAgentKind = "codex" | "claude" | "omp";

export const PROVIDER_HARNESSES: Record<AgentProviderKind, {
  harness: HerdrAgentKind;
  label: string;
  harnessLabel: string;
  healthCheckId: "codex-auth" | "claude-auth" | "openrouter-auth";
  servicePriorityLabels: Record<ServicePriority, string>;
}> = {
  codex: {
    harness: "codex",
    label: "Codex",
    harnessLabel: "Codex CLI",
    healthCheckId: "codex-auth",
    servicePriorityLabels: { standard: "Default", priority: "Priority", fast: "Fast" },
  },
  claude: {
    harness: "claude",
    label: "Claude Code",
    harnessLabel: "Claude Code CLI",
    healthCheckId: "claude-auth",
    servicePriorityLabels: { standard: "Standard", priority: "Priority tier", fast: "Fast mode" },
  },
  openrouter: {
    harness: "omp",
    label: "OpenRouter",
    harnessLabel: "omp (oh-my-pi)",
    healthCheckId: "openrouter-auth",
    servicePriorityLabels: { standard: "Default routing", priority: "Nitro (throughput)", fast: "Latency (fastest first)" },
  },
};

export function servicePriorityLabel(provider: AgentProviderKind, priority: string): string {
  if (!(SERVICE_PRIORITIES as readonly string[]).includes(priority)) return priority;
  return PROVIDER_HARNESSES[provider].servicePriorityLabels[priority as ServicePriority];
}
