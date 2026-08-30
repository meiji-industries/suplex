export type NewTaskMemory = {
  projectId?: string;
  deliveryTarget: "local_worktree" | "remote_branch" | "pull_request_draft" | "pull_request_ready" | "merged";
  autoApprovePlan: boolean;
  runProjectTests: boolean;
  visualEvidence: "off" | "capture" | "required";
  supplementalReview: boolean;
  roleAgents: { planner?: string; builder?: string; reviewer?: string; integrator?: string };
};

export const newTaskMemoryDefaults: NewTaskMemory = {
  deliveryTarget: "pull_request_draft",
  autoApprovePlan: false,
  runProjectTests: true,
  visualEvidence: "off",
  supplementalReview: false,
  roleAgents: {},
};

const storageKey = "forge.newTask.lastSettings";
const deliveryTargets = new Set<NewTaskMemory["deliveryTarget"]>(["local_worktree", "remote_branch", "pull_request_draft", "pull_request_ready", "merged"]);
const visualEvidenceValues = new Set<NewTaskMemory["visualEvidence"]>(["off", "capture", "required"]);
const roles = ["planner", "builder", "reviewer", "integrator"] as const;

export function readNewTaskMemory(storage: Pick<Storage, "getItem"> = localStorage): NewTaskMemory {
  try {
    const stored = storage.getItem(storageKey);
    if (!stored) return newTaskMemoryDefaults;
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return newTaskMemoryDefaults;
    const value = parsed as Record<string, unknown>;
    const storedRoleAgents = value.roleAgents && typeof value.roleAgents === "object" && !Array.isArray(value.roleAgents) ? value.roleAgents as Record<string, unknown> : {};
    const roleAgents = Object.fromEntries(roles.flatMap((role) => typeof storedRoleAgents[role] === "string" ? [[role, storedRoleAgents[role]]] : [])) as NewTaskMemory["roleAgents"];
    return {
      ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
      deliveryTarget: deliveryTargets.has(value.deliveryTarget as NewTaskMemory["deliveryTarget"]) ? value.deliveryTarget as NewTaskMemory["deliveryTarget"] : newTaskMemoryDefaults.deliveryTarget,
      autoApprovePlan: value.autoApprovePlan === true,
      runProjectTests: value.runProjectTests === true,
      visualEvidence: visualEvidenceValues.has(value.visualEvidence as NewTaskMemory["visualEvidence"]) ? value.visualEvidence as NewTaskMemory["visualEvidence"] : newTaskMemoryDefaults.visualEvidence,
      supplementalReview: value.supplementalReview === true,
      roleAgents,
    };
  } catch {
    return newTaskMemoryDefaults;
  }
}

export function writeNewTaskMemory(value: NewTaskMemory, storage: Pick<Storage, "setItem"> = localStorage): void {
  try { storage.setItem(storageKey, JSON.stringify(value)); }
  catch { /* Local storage may be unavailable. */ }
}

export function resolveNewTaskProjectId(rememberedProjectId: string | undefined, projects: ReadonlyArray<{ id: string }>): string {
  return rememberedProjectId && projects.some((project) => project.id === rememberedProjectId) ? rememberedProjectId : projects[0]?.id ?? "";
}
