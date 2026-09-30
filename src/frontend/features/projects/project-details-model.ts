import type { ProjectExecution } from "../../contracts/project-execution.js";
import type { ProjectIntegration } from "../../contracts/project-integration.js";
import { isProfileAllowed } from "./lib/provider-policy.js";
import type { ProjectProviderPolicy } from "../../contracts/provider-policy.js";
import type { AgentProfile } from "../../contracts/profiles.js";
import type { ProjectPatchBody } from "../../contracts/projects.js";
import type { ApiProject } from "../../shell/view-shared.js";

export type ProjectSection = "general" | "agents" | "execution" | "connections";

export const PROJECT_SECTIONS = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "execution", label: "Execution" },
  { id: "connections", label: "Connections" },
] as const satisfies ReadonlyArray<{ id: ProjectSection; label: string }>;

export type GeneralDraft = Pick<ApiProject, "name" | "baseBranch" | "repositoryPath"> & { repository: string };
export type AgentsDraft = Pick<ApiProject, "rootProfileId" | "workerProfileId" | "altProfileId"> & { providerPolicy: ProjectProviderPolicy | null };
export type AgentsDraftFinding = { field: "rootProfileId" | "workerProfileId" | "altProfileId"; message: string };
export type ExecutionDraft = Pick<ApiProject, "setupCommand" | "verificationCommand"> & Pick<ProjectExecution, "instructions"> & { skillDirectories: string; taskConcurrency: string };
export type ExecutionDraftFinding = { field: "taskConcurrency"; message: string };
export type ConnectionsDraft = { integration: ProjectIntegration; environment: string; mcp: string };

export function generalDraft(project: ApiProject): GeneralDraft {
  return { repository: project.repository ?? "", name: project.name, baseBranch: project.baseBranch, repositoryPath: project.repositoryPath };
}

export function agentsDraft(project: ApiProject): AgentsDraft {
  return { rootProfileId: project.rootProfileId, workerProfileId: project.workerProfileId, altProfileId: project.altProfileId, providerPolicy: project.providerPolicy ?? null };
}

export function executionDraft(project: ApiProject): ExecutionDraft {
  return {
    setupCommand: project.setupCommand,
    verificationCommand: project.verificationCommand,
    instructions: project.execution?.instructions ?? "",
    skillDirectories: project.execution?.skillDirectories.join("\n") ?? "",
    taskConcurrency: project.taskConcurrency?.toString() ?? "",
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
    ...(draft.repository !== saved.repository ? { repository: draft.repository } : {}),
    ...(draft.name !== saved.name ? { name: draft.name } : {}),
    ...(draft.baseBranch !== saved.baseBranch ? { baseBranch: draft.baseBranch } : {}),
    ...(draft.repositoryPath !== saved.repositoryPath ? { repositoryPath: draft.repositoryPath } : {}),
  };
}

export function agentsProjectPatch(saved: AgentsDraft, draft: AgentsDraft): ProjectPatchBody {
  return {
    ...(draft.rootProfileId !== saved.rootProfileId ? { rootProfileId: draft.rootProfileId } : {}),
    ...(draft.altProfileId !== saved.altProfileId ? { altProfileId: draft.altProfileId } : {}),
    ...(draft.workerProfileId !== saved.workerProfileId ? { workerProfileId: draft.workerProfileId } : {}),
    ...(JSON.stringify(draft.providerPolicy) !== JSON.stringify(saved.providerPolicy) ? { providerPolicy: draft.providerPolicy } : {}),
  };
}

export function agentsDraftFindings(draft: AgentsDraft, profiles: readonly Pick<AgentProfile, "id" | "role" | "provider" | "providerInstanceId">[]): AgentsDraftFinding[] {
  return ([
    ["rootProfileId", "root"],
    ["workerProfileId", "worker"],
    ["altProfileId", "root"],
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
    ...(draft.taskConcurrency.trim() !== saved.taskConcurrency ? { taskConcurrency: draft.taskConcurrency.trim() === "" ? null : Number(draft.taskConcurrency) } : {}),
  };
}

export function executionDraftFindings(draft: ExecutionDraft): ExecutionDraftFinding[] {
  const limit = draft.taskConcurrency.trim();
  return limit === "" || (/^\d+$/.test(limit) && Number.isSafeInteger(Number(limit)) && Number(limit) >= 1)
    ? []
    : [{ field: "taskConcurrency", message: "Write a whole number of 1 or more." }];
}

export function isProjectSection(value: string): value is ProjectSection {
  return PROJECT_SECTIONS.some((section) => section.id === value);
}
