import { discoverClaudeTranscript, parseClaudeChunk, claudeCandidatePaths, sanitizeClaudeLine } from "../claude-rollout.js";
import { discoverRollout, parseRolloutChunk, rolloutCandidatePaths, type RolloutCandidate, type RolloutParseResult, type RolloutParserInput } from "../codex-rollout.js";
import { sanitizeCodexLine } from "../codex-rollout-sanitizer.js";
import { prepareClaudeLaunch } from "./claude-launch.js";
import { discoverOmpSession, ompCandidatePaths, parseOmpChunk, sanitizeOmpLine } from "../omp-rollout.js";
import type { AgentProviderKind, HerdrAgentKind } from "./provider.js";
import type { RootBridgeConfig } from "../root-contracts.js";

export type AgentSessionCapability =
  | { kind: "root"; bridgeConfig: RootBridgeConfig; bridgeConfigPath: string }
  | { kind: "worker" };

export interface HerdrProviderRuntime {
  kind: HerdrAgentKind;
  presetSessionId: boolean;
  launchArgs(settings: { model: string; reasoningLevel: string; serviceTier: "default" | "priority" | "fast" }, sessionId: string | null, transcriptExists: boolean, initialPromptPath: string | undefined, capability: AgentSessionCapability): string[];
  candidatePaths(env: NodeJS.ProcessEnv): Promise<string[]>;
  discover(candidates: readonly string[], expected: { sessionId?: string; cwd: string; before?: ReadonlySet<string>; marker?: string; preferNewestMarker?: boolean }): Promise<RolloutCandidate>;
  parseChunk(input: RolloutParserInput, chunk: string, remainder?: string, state?: { activeTurnId?: string }): RolloutParseResult;
  sanitizeLine(line: string): string;
  prepareLaunch(input: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void>;
}
const codexArgs = (settings: { model: string; reasoningLevel: string; serviceTier: "default" | "priority" | "fast" }, sessionId: string | null, capability: AgentSessionCapability) => {
  const profile = ["--model", settings.model, "-c", `model_reasoning_effort=${JSON.stringify(settings.reasoningLevel)}`, "-c", `service_tier=${JSON.stringify(settings.serviceTier)}`, "-c", "check_for_update_on_startup=false"];
  if (capability.kind === "root") {
    const { command, args } = capability.bridgeConfig.server;
    profile.push("--sandbox", "read-only", "--ask-for-approval", "never", "-c", `mcp_servers.forge_root.command=${JSON.stringify(command)}`, "-c", `mcp_servers.forge_root.args=${JSON.stringify(args)}`, "-c", 'mcp_servers.forge_root.default_tools_approval_mode="approve"');
  } else {
    profile.push("--dangerously-bypass-approvals-and-sandbox");
  }
  return sessionId ? ["resume", ...profile, sessionId] : profile;
};
export const codexRuntime: HerdrProviderRuntime = { kind: "codex", presetSessionId: false, launchArgs: (settings, sessionId, _transcriptExists, _initialPromptPath, capability) => codexArgs(settings, sessionId, capability), candidatePaths: (env) => rolloutCandidatePaths(env.CODEX_HOME), discover: discoverRollout, parseChunk: parseRolloutChunk, sanitizeLine: sanitizeCodexLine, prepareLaunch: async () => {} };
export const claudeRuntime: HerdrProviderRuntime = { kind: "claude", presetSessionId: true, launchArgs(settings, sessionId, transcriptExists, _initialPromptPath, capability) { if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(settings.model) || !["low", "medium", "high", "xhigh"].includes(settings.reasoningLevel)) throw new Error("Claude launch settings are invalid"); if (capability.kind === "root") return ["--model", settings.model, "--effort", settings.reasoningLevel, "--restricted", "--tools", "Read,Grep,Glob,mcp__forge_root__forge_root", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--strict-mcp-config", "--mcp-config", capability.bridgeConfigPath, ...(transcriptExists ? ["--resume", sessionId] : ["--session-id", sessionId])]; return ["--model", settings.model, "--effort", settings.reasoningLevel, "--permission-mode", "bypassPermissions", ...(transcriptExists ? ["--resume", sessionId] : ["--session-id", sessionId])]; }, candidatePaths: claudeCandidatePaths, discover: discoverClaudeTranscript, parseChunk: parseClaudeChunk, sanitizeLine: sanitizeClaudeLine, prepareLaunch: prepareClaudeLaunch };
export const ompRuntime: HerdrProviderRuntime = { kind: "omp", presetSessionId: false, launchArgs(settings, sessionId, _transcriptExists, initialPromptPath, capability) { if (capability.kind === "root") throw new Error("OpenRouter cannot launch a Root session"); if (!/^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(settings.model) || !["low", "medium", "high", "xhigh"].includes(settings.reasoningLevel)) throw new Error("OpenRouter launch settings are invalid"); return ["--model", `openrouter/${settings.model}`, "--thinking", settings.reasoningLevel, "--approval-mode", "yolo", "--no-title", ...(sessionId ? ["--resume", sessionId] : []), ...(initialPromptPath ? [`@${initialPromptPath}`] : [])]; }, candidatePaths: ompCandidatePaths, discover: discoverOmpSession, parseChunk: parseOmpChunk, sanitizeLine: sanitizeOmpLine, prepareLaunch: async () => {} };
export function herdrRuntime(kind: AgentProviderKind): HerdrProviderRuntime {
  if (kind === "codex") return codexRuntime;
  if (kind === "claude") return claudeRuntime;
  if (kind === "openrouter") return ompRuntime;
  throw new Error("OpenCode providers require the native task runtime");
}
