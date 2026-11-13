import { Zap } from "lucide-react";
import { providerIcons } from "../../components/app/provider-icons.js";
import type { HarnessKind } from "../../contracts/generated/HarnessKind.js";
import type { ReasoningLevel } from "../../contracts/generated/ReasoningLevel.js";
import type { ServiceTier } from "../../contracts/generated/ServiceTier.js";

/** The runtime fields of an agent profile or of a task's profile snapshot. */
export type AgentRuntime = { provider: HarnessKind; model: string; reasoningLevel: ReasoningLevel; serviceTier?: ServiceTier };

const REASONING_LABELS: Record<ReasoningLevel, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };
/** Model words that read as letters. */
const ACRONYMS = new Set(["gpt", "swe", "glm", "oss", "ai"]);
const VERSION = /^\d+(\.\d+)*$/;

export function providerLabel(provider: HarnessKind): string {
  return providerIcons[provider]?.label ?? provider;
}

export function reasoningLabel(level: ReasoningLevel): string {
  return REASONING_LABELS[level] ?? level;
}

/**
 * A readable name for a model id: `opus` is "Opus", `claude-opus-5-5` is "Opus 5.5", `gpt-5.6-sol` is "GPT-5.6 Sol".
 * OpenCode ids are `vendor/model`; the name comes from the part after the last slash.
 */
export function modelLabel(model: string): string {
  const id = model.slice(model.lastIndexOf("/") + 1).replace(/^claude-(?=[a-z])/i, "").replace(/-\d{8}$/, "");
  const words: string[] = [];
  for (const token of id.split(/[-_\s]+/).filter(Boolean)) {
    const previous = words.at(-1);
    if (VERSION.test(token) && previous !== undefined) {
      // Version parts in separate tokens (`5-5`) join with a dot; an acronym takes its version with a hyphen (`GPT-5.6`).
      if (/\d$/.test(previous) && /^\d+$/.test(token)) words[words.length - 1] = `${previous}.${token}`;
      else if (ACRONYMS.has(previous.toLowerCase())) words[words.length - 1] = `${previous}-${token}`;
      else words.push(token);
      continue;
    }
    words.push(ACRONYMS.has(token.toLowerCase()) ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1));
  }
  return words.join(" ") || model;
}

/** "Claude Code · Opus High". `priority` adds " · Priority" for the priority service tier, for text-only places. */
export function agentSummary(agent: AgentRuntime, { priority = false }: { priority?: boolean } = {}): string {
  const summary = `${providerLabel(agent.provider)} · ${modelLabel(agent.model)} ${reasoningLabel(agent.reasoningLevel)}`;
  return priority && agent.serviceTier === "priority" ? `${summary} · Priority` : summary;
}

/** The agent summary, with a Priority icon for the priority service tier. */
export function AgentSummary({ agent }: { agent: AgentRuntime }) {
  return <>{agentSummary(agent)}{agent.serviceTier === "priority" ? <> <span title="Priority"><Zap className="inline size-3.5 align-text-bottom" role="img" aria-label="Priority" /></span></> : null}</>;
}
