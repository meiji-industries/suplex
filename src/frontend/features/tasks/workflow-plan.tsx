import { GitPullRequest, GitMerge, Route, Wrench } from "lucide-react";
import { type Task } from "../../contracts/tasks.js";
import { ADVISOR_LABELS, workflowDefinition } from "./workflow-presentation.js";
import { taskDeliveryTargetOptions } from "./task-delivery-target.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { Plan, PlanAction, PlanContent, PlanDescription, PlanHeader, PlanTitle, PlanTrigger } from "../../components/ui/plan.js";
import { workflowTopology, type WorkflowStation } from "./workflow-plan-model.js";

function deliveryLabel(task: Task): string {
  return taskDeliveryTargetOptions.find(option => option.value === task.deliveryTarget)?.label ?? "Selected target";
}

function StationView({ task, station }: { task: Task; station: WorkflowStation }) {
  const profile = station.role === "coordinator" ? task.rootProfile : station.role === "worker" ? task.workerProfile : station.role ? task.advisorProfiles[station.role] ?? task.rootProfile : null;
  const name = station.role === "coordinator" ? "Coordinator" : station.role === "worker" ? "Worker" : station.role ? ADVISOR_LABELS[station.role] : station.label;
  const Icon = station.icon === "delivery" ? GitPullRequest : station.icon === "merge" ? GitMerge : station.icon === "target" ? Route : Wrench;
  return <li data-workflow-station={station.id} className="absolute z-10 flex min-w-0 items-center gap-2 border border-border bg-background px-2 py-1.5 text-xs" style={{ left: `${station.x / 3.9}%`, top: station.y, width: `${(station.width ?? 190) / 3.9}%`, height: station.height }}>
    {profile ? <EntityAvatar kind="agent" id={profile.profileId} name={name} size="xs" /> : <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
    <span className="min-w-0"><span className="block font-medium leading-4">{station.label}</span>{station.note ? <span className="block text-xs leading-4 text-muted-foreground">{station.note}</span> : null}</span>
  </li>;
}

export function WorkflowPlan({ task }: { task: Task }) {
  const definition = workflowDefinition(task.workflow);
  const topology = workflowTopology(task.workflow, deliveryLabel(task));
  return <section aria-label="Workflow plan" data-workflow-plan={task.workflow}><Plan>
    <PlanHeader><div><PlanTitle>Workflow plan</PlanTitle><PlanDescription>{definition.name}</PlanDescription></div><PlanAction><PlanTrigger label="Open or close the workflow plan" /></PlanAction></PlanHeader>
    <PlanContent><div className="min-w-0">
      <div className="workflow-topology relative w-full max-w-[760px]" style={{ height: topology.height }}>
        <svg className="absolute inset-0 size-full overflow-visible text-muted-foreground" viewBox={`0 0 390 ${topology.height}`} preserveAspectRatio="none" aria-hidden="true"><defs><marker id={`workflow-arrow-${task.id}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="currentColor" /></marker></defs>{topology.edges.map(edge => <path key={`${edge.from}-${edge.to}`} data-workflow-edge={`${edge.from}-${edge.to}`} d={edge.path} fill="none" stroke="currentColor" strokeWidth="1.5" markerEnd={`url(#workflow-arrow-${task.id})`} />)}</svg>
        <ol className="relative m-0 list-none p-0" aria-label={`${definition.name} workflow stations`} style={{ height: topology.height }}>{topology.nodes.map(station => <StationView key={station.id} task={task} station={station} />)}</ol>
        <ul className="sr-only" aria-label={`${definition.name} workflow relationships`}>{topology.edges.map(edge => {
          const from = topology.nodes.find(station => station.id === edge.from)!;
          const to = topology.nodes.find(station => station.id === edge.to)!;
          return <li key={`${edge.from}-${edge.to}`}>{from.label} to {to.label}{edge.condition ? `: ${edge.condition}.` : "."}</li>;
        })}</ul>
        {topology.edges.flatMap(edge => edge.condition && edge.label ? [<span key={`${edge.from}-${edge.to}-label`} data-workflow-edge-label={`${edge.from}-${edge.to}`} className="absolute z-20 max-w-32 bg-background px-1 text-xs leading-3 text-muted-foreground" style={{ left: `${edge.label.x / 3.9}%`, top: edge.label.y, width: edge.label.width }}>{edge.condition}</span>] : [])}
      </div>
    </div></PlanContent>
  </Plan></section>;
}
