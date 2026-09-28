import { useId, type ReactNode } from "react";
import { Combine, Crosshair, FileText, GitMerge, GitPullRequest, ListChecks, ScanEye, Send, Terminal, UserRound, type LucideIcon } from "lucide-react";
import type { WorkflowId } from "../../contracts/workflows.js";
import { REPAIR_RATING_TARGET, type AdvisorRole } from "../../contracts/advisor-reports.js";
import { workflowDefinition } from "./workflow-presentation.js";
import layouts from "./workflow-layouts.json" with { type: "json" };
import suplexMark from "../../assets/suplex-mark.svg?inline";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";

type Tone = "coordinator" | "worker" | "planner" | "advisor" | "source";
type AgentControls = Partial<Record<"root" | "worker" | AdvisorRole, ReactNode>>;
type Point = { x: number; y: number };
const tones: Record<Tone, string> = {
  coordinator: "text-violet-600 dark:text-violet-400",
  worker: "text-teal-700 dark:text-teal-400",
  planner: "text-blue-600 dark:text-blue-400",
  advisor: "text-amber-700 dark:text-amber-400",
  source: "text-muted-foreground",
};

function Label({ x, y, children, caption }: { x: number; y: number; children: ReactNode; caption?: string | undefined }) {
  return <g textAnchor="middle" className="fill-foreground text-[13px] font-medium">
    <text x={x} y={y}>{children}</text>
    {caption ? <text x={x} y={y + 16} className="fill-muted-foreground text-xs font-normal">{caption}</text> : null}
  </g>;
}

function SuplexAgent() {
  return <span className="inline-flex h-6 items-center gap-1 font-medium"><img src={suplexMark} alt="" className="size-4 invert dark:invert-0" />Suplex</span>;
}

function Station({ id, x, y, label, caption, icon: Icon, tone = "source", sheet = false, labelAt = [x, y + 36], viewWidth, control }: {
  id: string; x: number; y: number; label: string; caption?: string | undefined; icon: LucideIcon; tone?: Tone; sheet?: boolean; labelAt?: [number, number]; viewWidth: number; control?: ReactNode;
}) {
  const controlX = Math.max(0, Math.min(viewWidth - 160, labelAt[0] - 80));
  return <g data-illustration-station={id}>
    <g className={tones[tone]}>
      {sheet ? <>
        <rect x={x - 12} y={y - 20} width="32" height="32" rx="5" className="fill-current opacity-10 dark:opacity-20" />
        <rect x={x - 16} y={y - 16} width="32" height="32" rx="5" className="fill-card" stroke="currentColor" strokeOpacity=".65" />
      </> : <>
        <circle cx={x} cy={y} r="22" className="fill-current opacity-10 dark:opacity-20" />
        <circle cx={x} cy={y} r="16" className="fill-card" stroke="currentColor" strokeOpacity=".65" />
      </>}
      <Icon x={x - 8} y={y - 8} width="16" height="16" strokeWidth="1.6" aria-hidden="true" />
    </g>
    {control ? <foreignObject x={controlX} y={labelAt[1] - 14} width="160" height="64" data-illustration-control={id}>
      <div className="grid min-w-0 justify-items-center p-1 text-center text-xs leading-4">{control}{caption ? <span>{caption}</span> : null}</div>
    </foreignObject> : <Label x={labelAt[0]} y={labelAt[1]} caption={caption}>{label}</Label>}
  </g>;
}

const stationMeta = {
  objective: { label: "Objective", icon: Crosshair, tone: "source" },
  source: { label: "Pull request", icon: GitPullRequest, tone: "source" },
  plan: { label: "Coordinator", icon: ListChecks, tone: "coordinator", role: "root" },
  "plan-a": { label: "Plan A", icon: FileText, tone: "planner", role: "planner_a", sheet: true },
  "plan-b": { label: "Plan B", icon: FileText, tone: "advisor", role: "planner_b", sheet: true },
  combine: { label: "Coordinator", caption: "combines plans", icon: Combine, tone: "coordinator", role: "root" },
  build: { label: "Worker", caption: "does the work", icon: Terminal, tone: "worker", role: "worker" },
  review: { label: "Coordinator", caption: "reviews and checks", icon: ScanEye, tone: "coordinator", role: "root" },
  reviewer: { label: "Reviewer", caption: "checks", icon: ScanEye, tone: "advisor", role: "reviewer" },
  rater: { label: "Rater", caption: "rates", icon: ScanEye, tone: "advisor", role: "rater" },
  coordinator: { label: "Coordinator", caption: "directs the next step", icon: ListChecks, tone: "coordinator", role: "root" },
  repair: { label: "Worker", caption: "repairs and checks", icon: Terminal, tone: "worker", role: "worker" },
  delivery: { label: "Suplex", icon: GitPullRequest, tone: "source" },
  merge: { label: "Suplex", caption: "merges the PR", icon: GitMerge, tone: "source" },
} as const;
type StationId = keyof typeof stationMeta;

function routePath(points: Point[]): string {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join("");
}

function Artwork({ workflow, delivery, compact, agents, arrowId, author, pullRequestNumber }: { workflow: WorkflowId; delivery: string; compact: boolean; agents: AgentControls; arrowId: string; author: ReactNode; pullRequestNumber: number | undefined }) {
  const layout = layouts[workflow][compact ? "compact" : "wide"];
  const viewWidth = compact ? 320 : 768;
  const offsetX = (viewWidth - layout.width) / 2;
  const offsetY = compact ? 8 : workflow === "competing_plans" ? 55 : workflow === "refine_pull_request" ? 70 : 20;
  const nodePoints = Object.fromEntries(layout.nodes.map(node => [node.id, { x: node.x + 22 + offsetX, y: node.y + 22 + offsetY }]));
  return <>
    <g transform={`translate(${offsetX} ${offsetY})`}>
      {layout.edges.map(edge => {
        const from = edge.id.split("-").slice(0, -1).join("-");
        const tone = stationMeta[from as StationId]?.tone ?? "source";
        const returns = edge.id === "review-build" || edge.id === "reviewer-build" || edge.id === "repair-rater";
        return <path key={edge.id} data-illustration-route={edge.id} d={routePath(edge.points)} className={tones[tone]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={returns ? "3 5" : undefined} markerEnd={`url(#${arrowId}-${tone})`} />;
      })}
    </g>
    {layout.nodes.map(node => {
      const id = node.id as StationId;
      const meta = stationMeta[id];
      const { x, y } = nodePoints[id]!;
      const role = "role" in meta ? meta.role : undefined;
      const deliveryNode = id === "delivery" || id === "merge";
      const control = id === "objective" ? author : deliveryNode ? <SuplexAgent /> : role ? agents[role] : undefined;
      const caption = id === "plan" ? workflow === "direct_build" ? "delegates" : "writes the plan"
        : id === "objective" ? "prompts"
        : id === "plan-a" || id === "plan-b" ? "plans"
        : id === "rater" ? `rates · ${REPAIR_RATING_TARGET}/10 or more`
        : deliveryNode ? id === "merge" ? "merges the PR" : delivery : "caption" in meta ? meta.caption : undefined;
      let labelAt: [number, number] = [x, y + 36];
      if (!compact && workflow === "competing_plans" && id === "plan-a") labelAt = [x, y - 44];
      if (!compact && workflow === "independent_review") labelAt = [x, y + 58];
      if (!compact && workflow === "refine_pull_request" && id === "repair") labelAt = [x, y - 54];
      if (compact && !deliveryNode) {
        if ((id === "plan-a" || id === "plan-b") && !control) labelAt = [x + (id === "plan-a" ? 56 : -56), y - 20];
        else if (id === "plan-a" || id === "plan-b" || id === "repair") labelAt = [x, y + 36];
        else labelAt = [x + (id === "plan" || id === "build" || id === "review" || id === "rater" ? -88 : 88), y - 2];
      }
      return <Station key={id} id={id} x={x} y={y} label={id === "source" && pullRequestNumber ? `PR #${pullRequestNumber}` : meta.label} caption={caption} icon={id === "plan" && workflow === "direct_build" ? Send : meta.icon}
        tone={meta.tone} sheet={"sheet" in meta && meta.sheet} labelAt={labelAt} viewWidth={viewWidth}
        control={control} />;
    })}
  </>;
}

export function WorkflowIllustration({ workflow, delivery, agents = {}, pullRequestNumber }: { workflow: WorkflowId; delivery: string; agents?: AgentControls; pullRequestNumber?: number | undefined }) {
  const id = useId();
  const user = useOptionalCompanyContext()?.user;
  const author = <span className="inline-flex h-6 items-center gap-1 font-medium">{user ? <EntityAvatar kind="user" id={user.id} name={user.displayName} seed={user.avatarSeed} size="xs" /> : <UserRound className="size-4" />}{user?.displayName ?? "User"}</span>;
  const definition = workflowDefinition(workflow);
  const description = `${definition.steps.join(" ")}${workflow === "refine_pull_request" ? " Coordinator directs repair or delivery after each rating." : " Coordinator can send changes back to Worker after review."} Delivery: ${delivery}.`;
  const deliveryAction = ({
    "Keep in worktree": "keeps changes local",
    "Push branch": "pushes the branch",
    "Draft pull request": "opens a draft PR",
    "Ready for review": "opens a ready PR",
    "Merge to base": "merges the PR",
    "Merged pull request": "merges the PR",
  } as Record<string, string>)[delivery] ?? delivery;
  return <div className="@container" data-workflow-illustration={workflow}>
    {[false, true].map(compact => {
      const layout = layouts[workflow][compact ? "compact" : "wide"];
      const height = layout.height + (compact ? 78 : workflow === "refine_pull_request" ? 160 : 110);
      const arrowId = `${id.replaceAll(":", "")}-${compact}-arrow`;
      return <svg key={String(compact)} className={compact ? "mx-auto block w-full max-w-80 @min-[640px]:hidden" : "mx-auto hidden w-full max-w-3xl @min-[640px]:block"}
        viewBox={`0 0 ${compact ? 320 : 768} ${height}`} role={Object.keys(agents).length ? "group" : "img"}
        aria-labelledby={`${id}-${compact}-title`} aria-describedby={`${id}-${compact}-description`}>
        <title id={`${id}-${compact}-title`}>{`${definition.name} workflow`}</title>
        <desc id={`${id}-${compact}-description`}>{description}</desc>
        <defs>{(Object.entries(tones) as [Tone, string][]).map(([tone, className]) =>
          <marker key={tone} id={`${arrowId}-${tone}`} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 8 4 0 8z" className={className} fill="currentColor" /></marker>)}</defs>
        <Artwork workflow={workflow} delivery={deliveryAction} compact={compact} agents={agents} arrowId={arrowId} author={author} pullRequestNumber={pullRequestNumber} />
      </svg>;
    })}
  </div>;
}
