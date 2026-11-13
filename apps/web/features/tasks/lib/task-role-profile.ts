import { useQuery } from "@tanstack/react-query";
import type { TaskAgentSelectionRequest } from "../../../contracts/agent-selection.js";
import type { TaskProfile } from "../../../contracts/generated/TaskProfile.js";
import type { ProfileResponse } from "../../../contracts/projects.js";
import type { Task } from "../../../contracts/tasks.js";
import { ADVISOR_LABELS } from "../workflow-presentation.js";
import { listTaskProfiles } from "./task-api.js";

export type TaskAgentRole = TaskAgentSelectionRequest["role"];

export const taskAgentLabel = (role: TaskAgentRole): string => role === "root" ? "Coordinator" : role === "worker" ? "Worker" : ADVISOR_LABELS[role];

/** The profile snapshot the task captured for a role. An advisor without its own profile uses the Coordinator profile. */
export const taskRoleSnapshot = (task: Task, role: TaskAgentRole): TaskProfile =>
  role === "root" ? task.rootProfile : role === "worker" ? task.workerProfile : task.advisorProfiles[role] ?? task.rootProfile;

/** How a task role's agent displays: the workflow diagram and the task sidebar use the same name and avatar. */
export type TaskRoleAgent = {
  /** The assigned profile. Archived profiles stay: a task keeps the agent it was given. */
  profile: ProfileResponse | undefined;
  snapshot: TaskProfile;
  name: string;
  /** EntityAvatar identity: the profile id, name, and avatar seed. */
  avatar: { id: string; name: string; seed?: string };
};

export function taskRoleAgent(task: Task, role: TaskAgentRole, profiles: readonly ProfileResponse[] | undefined): TaskRoleAgent {
  const snapshot = taskRoleSnapshot(task, role);
  const profile = profiles?.find(item => item.id === snapshot.profileId);
  const name = profile?.name ?? taskAgentLabel(role);
  return { profile, snapshot, name, avatar: profile ? { id: profile.id, name, seed: profile.avatarSeed } : { id: snapshot.profileId, name } };
}

export const taskProfilesKey = ["task-profiles"] as const;

/** All agent profiles, archived included, for the display of task agents. */
export function useTaskProfiles() {
  return useQuery({ queryKey: taskProfilesKey, queryFn: ({ signal }) => listTaskProfiles(signal), staleTime: 30_000 });
}
