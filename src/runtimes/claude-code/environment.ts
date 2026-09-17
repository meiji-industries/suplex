/** Dedicated Claude logins must not inherit a different account or gateway. */
export function claudeRoutingVariable(name: string): boolean {
  return /^(ANTHROPIC_|CLAUDE_CODE_(?:USE_|OAUTH|API_KEY|SKIP_|BEDROCK|VERTEX|FOUNDRY)|CLAUDE_CONFIG_DIR$)/.test(name);
}

export function claudeEnvironment(directory: string | null | undefined, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!directory) return { ...inherited };
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !claudeRoutingVariable(key))), CLAUDE_CONFIG_DIR: directory, ANTHROPIC_CONFIG_DIR: join(directory, "anthropic") };
}

export function claudeSettingsArguments(isolated: boolean): string[] {
  return isolated ? ["--setting-sources", ""] : [];
}
import { join } from "node:path";

export const CLAUDE_AUTH_ENVIRONMENT_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_PROFILE", "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CONFIG_DIR"];
