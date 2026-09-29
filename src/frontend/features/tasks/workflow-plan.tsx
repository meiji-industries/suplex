import { useEffect, useState } from "react";
import type { Task } from "../../contracts/tasks.js";
import type { ProfileResponse } from "../../contracts/projects.js";
import { workflowDefinition } from "./workflow-presentation.js";
import { taskDeliveryTargetOptions } from "./task-delivery-target.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { WorkflowIllustration } from "./workflow-illustration.js";
import { listTaskProfiles } from "./lib/task-api.js";

function deliveryLabel(task: Task): string {
  return taskDeliveryTargetOptions.find(option => option.value === task.deliveryTarget)?.label ?? "Selected target";
}

export function WorkflowPlan({ task }: { task: Task }) {
  const definition = workflowDefinition(task.workflow);
  const source = task.configuration.source;
  const [profiles, setProfiles] = useState<ProfileResponse[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void listTaskProfiles(controller.signal).then(setProfiles).catch(() => undefined);
    return () => controller.abort();
  }, []);
  const profileFor = (profileId: string) => profiles.find(profile => profile.id === profileId && !profile.archivedAt);
  const profileAssignments = {
    root: profileFor(task.rootProfile.profileId),
    worker: profileFor(task.workerProfile.profileId),
    ...Object.fromEntries(definition.advisorRoles.map(role => [role, profileFor((task.advisorProfiles[role] ?? task.rootProfile).profileId)])),
  };
  const agentNames = Object.fromEntries(Object.entries(profileAssignments).flatMap(([role, profile]) => profile ? [[role, profile.name]] : []));
  const avatars = Object.fromEntries(Object.entries(profileAssignments).flatMap(([role, profile]) => profile ? [[role, <EntityAvatar key={profile.id} kind="agent" id={profile.id} name={profile.name} seed={profile.avatarSeed} size="default" />]] : []));
  const delivery = task.workflow === "refine_pull_request" ? "Merged pull request" : deliveryLabel(task);
  const pullRequestNumber = source?.kind === "pull_request" ? source.number : task.pullRequest?.number;
  return <section aria-label="Workflow plan" data-workflow-plan={task.workflow} className="min-w-0 pb-6">
    <WorkflowIllustration fit workflow={task.workflow} delivery={delivery} pullRequestNumber={pullRequestNumber} agentNames={agentNames} avatars={avatars} />
  </section>;
}
