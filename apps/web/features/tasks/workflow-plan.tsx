import type { Task } from "../../contracts/tasks.js";
import { workflowDefinition } from "./workflow-presentation.js";
import { taskDeliveryTargetOptions } from "./task-delivery-target.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { WorkflowIllustration } from "./workflow-illustration.js";
import { taskRoleAgent, useTaskProfiles, type TaskAgentRole } from "./lib/task-role-profile.js";
import type { TaskActivityResponse } from "../../contracts/generated/TaskActivityResponse.js";
import { useTaskAgents } from "./task-data.js";
import { workflowPosition } from "./workflow-position.js";

function deliveryLabel(task: Task): string {
  return taskDeliveryTargetOptions.find(option => option.value === task.deliveryTarget)?.label ?? "Selected target";
}

export function WorkflowPlan({ task, activity }: { task: Task; activity: TaskActivityResponse }) {
  const definition = workflowDefinition(task.workflow);
  const agents = useTaskAgents([task.id]).data?.find(entry => entry.taskId === task.id)?.agents;
  const position = workflowPosition(task, activity, agents);
  const source = task.configuration.source;
  const profiles = useTaskProfiles().data;
  // Without the profile list, the illustration keeps its role names.
  const assigned = profiles ? (["root", "worker", ...definition.advisorRoles] satisfies TaskAgentRole[]).map(role => [role, taskRoleAgent(task, role, profiles)] as const).filter(([, agent]) => agent.profile) : [];
  const agentNames = Object.fromEntries(assigned.map(([role, agent]) => [role, agent.name]));
  const avatars = Object.fromEntries(assigned.map(([role, agent]) => [role, <EntityAvatar key={agent.avatar.id} kind="agent" {...agent.avatar} size="default" />]));
  const delivery = task.workflow === "refine_pull_request" ? "Merged pull request" : deliveryLabel(task);
  const pullRequestNumber = source?.kind === "pull_request" ? source.number : task.pullRequest?.number;
  return <section aria-label="Workflow plan" data-workflow-plan={task.workflow} className="min-w-0 pb-6">
    <WorkflowIllustration workflow={task.workflow} delivery={delivery} pullRequestNumber={pullRequestNumber} agentNames={agentNames} avatars={avatars} position={position} />
  </section>;
}
