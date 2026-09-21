import type { ProjectExecution } from "../../../projects/execution-configuration.js";
import type { ProjectIntegration } from "../../../projects/integration-configuration.js";
import { isProfileAllowed, type ProjectProviderPolicy } from "../../../projects/provider-policy.js";
import type { AgentProfile } from "../../../profiles/agent-profile-contracts.js";
import type { ProjectPatchBody } from "../../../http/contracts/projects.js";
import type { ApiProject } from "../../shell/view-shared.js";

export type ProjectSection = "general" | "agents" | "execution" | "connections";

export const PROJECT_SECTIONS = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "execution", label: "Execution" },
  { id: "connections", label: "Connections" },
] as const satisfies ReadonlyArray<{ id: ProjectSection; label: string }>;

export type GeneralDraft = Pick<ApiProject, "name" | "baseBranch">;
export type AgentsDraft = Pick<ApiProject, "rootProfileId" | "workerProfileId"> & { providerPolicy: ProjectProviderPolicy | null };
export type AgentsDraftFinding = { field: "rootProfileId" | "workerProfileId"; message: string };
export type ExecutionDraft = Pick<ApiProject, "setupCommand" | "verificationCommand"> & Pick<ProjectExecution, "instructions"> & { skillDirectories: string };
export type ConnectionsDraft = { integration: ProjectIntegration; environment: string; mcp: string };

export function generalDraft(project: ApiProject): GeneralDraft {
  return { name: project.name, baseBranch: project.baseBranch };
}

export function agentsDraft(project: ApiProject): AgentsDraft {
  return { rootProfileId: project.rootProfileId, workerProfileId: project.workerProfileId, providerPolicy: project.providerPolicy ?? null };
}

export function executionDraft(project: ApiProject): ExecutionDraft {
  return {
    setupCommand: project.setupCommand,
    verificationCommand: project.verificationCommand,
    instructions: project.execution?.instructions ?? "",
    skillDirectories: project.execution?.skillDirectories.join("\n") ?? "",
  };
}

export function connectionsDraft(project: ApiProject): ConnectionsDraft {
  return {
    integration: project.integration ?? { repository: { kind: "github" }, tracker: project.repository ? { kind: "github", repository: project.repository } : null },
    environment: JSON.stringify(project.execution?.environment ?? {}, null, 2),
    mcp: JSON.stringify(project.execution?.mcp ?? [], null, 2),
  };
}

export function generalProjectPatch(saved: GeneralDraft, draft: GeneralDraft): ProjectPatchBody {
  return {
    ...(draft.name !== saved.name ? { name: draft.name } : {}),
    ...(draft.baseBranch !== saved.baseBranch ? { baseBranch: draft.baseBranch } : {}),
  };
}

export function agentsProjectPatch(saved: AgentsDraft, draft: AgentsDraft): ProjectPatchBody {
  return {
    ...(draft.rootProfileId !== saved.rootProfileId ? { rootProfileId: draft.rootProfileId } : {}),
    ...(draft.workerProfileId !== saved.workerProfileId ? { workerProfileId: draft.workerProfileId } : {}),
    ...(JSON.stringify(draft.providerPolicy) !== JSON.stringify(saved.providerPolicy) ? { providerPolicy: draft.providerPolicy } : {}),
  };
}

export function agentsDraftFindings(draft: AgentsDraft, profiles: readonly Pick<AgentProfile, "id" | "role" | "provider" | "providerInstanceId">[]): AgentsDraftFinding[] {
  return ([
    ["rootProfileId", "root"],
    ["workerProfileId", "worker"],
  ] as const).flatMap(([field, role]) => {
    const profile = profiles.find((candidate) => candidate.id === draft[field] && candidate.role === role);
    return !draft[field] || (profile !== undefined && !isProfileAllowed(draft.providerPolicy, profile))
      ? [{ field, message: "Select an agent with a provider and login allowed by this project" }]
      : [];
  });
}

export function executionProjectPatch(saved: ExecutionDraft, draft: ExecutionDraft): ProjectPatchBody {
  const execution: NonNullable<ProjectPatchBody["execution"]> = {
    ...(draft.instructions !== saved.instructions ? { instructions: draft.instructions } : {}),
    ...(draft.skillDirectories !== saved.skillDirectories ? { skillDirectories: draft.skillDirectories.split("\n").map((path) => path.trim()).filter(Boolean) } : {}),
  };
  return {
    ...(draft.setupCommand !== saved.setupCommand ? { setupCommand: draft.setupCommand } : {}),
    ...(draft.verificationCommand !== saved.verificationCommand ? { verificationCommand: draft.verificationCommand } : {}),
    ...(Object.keys(execution).length > 0 ? { execution } : {}),
  };
}

export function isProjectSection(value: string): value is ProjectSection {
  return PROJECT_SECTIONS.some((section) => section.id === value);
}
