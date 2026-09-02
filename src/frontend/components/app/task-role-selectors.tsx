import { ChevronDown } from "lucide-react";
import type { ReactElement } from "react";

import type { DeliveryTarget } from "../../../tasks.js";
import type { ApiAgent } from "../../lib/view-shared.js";
import { Button } from "../ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { ProfileAvatar } from "./profile-avatar.js";

export type TaskAgentRole = ApiAgent["role"];
export type TaskRoleAssignments = Partial<Record<TaskAgentRole, string | undefined>>;

const roleLabels: Record<TaskAgentRole, string> = {
  planner: "Planner",
  reviewer: "Reviewer",
  builder: "Builder",
  integrator: "Integrator",
};

const taskAgentRoles: TaskAgentRole[] = ["planner", "reviewer", "builder", "integrator"];

export function taskRoleDisabled(role: TaskAgentRole, deliveryTarget: DeliveryTarget, supplementalReview: boolean): boolean {
  if (role === "reviewer") return !supplementalReview && deliveryTarget !== "merged";
  if (role === "integrator") return deliveryTarget === "local_worktree" || deliveryTarget === "remote_branch";
  return false;
}

function disabledReason(role: TaskAgentRole, deliveryTarget: DeliveryTarget, supplementalReview: boolean): string | undefined {
  if (role === "reviewer" && taskRoleDisabled(role, deliveryTarget, supplementalReview)) return "Enable Second review to assign a Reviewer.";
  if (role === "integrator" && taskRoleDisabled(role, deliveryTarget, supplementalReview)) return "The Integrator is not used for worktree or branch delivery.";
  return undefined;
}

function TaskRoleSelector({ role, agents, assignment, disabled, disabledReason: reason, onChange }: {
  role: TaskAgentRole;
  agents: ApiAgent[];
  assignment?: string | undefined;
  disabled: boolean;
  disabledReason?: string | undefined;
  onChange: (agentId: string) => void;
}): ReactElement {
  const label = roleLabels[role];
  const selectedAgent = agents.find((agent) => agent.id === assignment);
  const availableAgents = agents.filter((agent) => agent.role === role);
  const accessibleLabel = selectedAgent ? `${label} assignee: ${selectedAgent.name}` : `${label} assignee: None`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" aria-label={accessibleLabel} disabled={disabled} title={reason} />}>
        {selectedAgent ? <ProfileAvatar name={selectedAgent.name} seed={selectedAgent.avatarSeed} size="xs" /> : null}
        {selectedAgent ? selectedAgent.name : label}
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={assignment ?? ""} onValueChange={onChange}>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {role === "builder" ? null : <DropdownMenuRadioItem value="">None</DropdownMenuRadioItem>}
          {availableAgents.map((agent) => (
            <DropdownMenuRadioItem key={agent.id} value={agent.id}>
              <ProfileAvatar name={agent.name} seed={agent.avatarSeed} />
              <span>{agent.name} · {agent.model} · {agent.reasoningLevel} · {agent.servicePriority}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TaskRoleSelectors({ agents, assignments, deliveryTarget, supplementalReview, busy, onChange }: {
  agents: ApiAgent[];
  assignments: TaskRoleAssignments;
  deliveryTarget: DeliveryTarget;
  supplementalReview: boolean;
  busy: boolean;
  onChange: (role: TaskAgentRole, agentId: string) => void;
}): ReactElement {
  return <>
    {taskAgentRoles.map((role) => {
      const roleIsDisabled = taskRoleDisabled(role, deliveryTarget, supplementalReview);
      return <TaskRoleSelector key={role} role={role} agents={agents} assignment={assignments[role]} disabled={busy || roleIsDisabled} disabledReason={roleIsDisabled ? disabledReason(role, deliveryTarget, supplementalReview) : undefined} onChange={(agentId) => onChange(role, agentId)} />;
    })}
  </>;
}
