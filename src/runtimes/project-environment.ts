import type { ProjectIntegration } from "../projects/integration-configuration.js";
import type { ProjectMcp } from "./project-mcp.js";

export function projectCredentialEnvironmentKeys(integration: ProjectIntegration | undefined, mcp: ProjectMcp = []): string[] {
  return [
    ...(integration?.repository.kind === "bitbucket" ? [integration.repository.tokenEnvironment, integration.repository.usernameEnvironment] : []),
    ...(integration?.tracker?.kind === "jira" ? [integration.tracker.emailEnvironment, integration.tracker.tokenEnvironment] : []),
    ...mcp.flatMap(server => Object.values(server.transport.type === "http" ? server.transport.headers : server.transport.env)),
  ].filter((key): key is string => Boolean(key));
}

export function excludeEnvironmentKeys(environment: NodeJS.ProcessEnv, excluded: readonly string[] = []): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !excluded.includes(key)));
}
