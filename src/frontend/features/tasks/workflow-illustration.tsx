import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Combine, Crosshair, FileText, GitMerge, GitPullRequest, ListChecks, ScanEye, Send, Terminal, UserRound, type LucideIcon } from "lucide-react";
import type { WorkflowId } from "../../contracts/workflows.js";
import { REPAIR_RATING_TARGET, type AdvisorRole } from "../../contracts/advisor-reports.js";
import { workflowDefinition } from "./workflow-presentation.js";
import { animateFlow, flowEdges } from "./workflow-flow.js";
import type { WorkflowPosition } from "./workflow-position.js";
import layouts from "./workflow-layouts.json" with { type: "json" };
import suplexMark from "../../assets/suplex-mark.svg?inline";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";

type Tone = "coordinator" | "worker" | "planner" | "advisor" | "source";
type AgentControls = Partial<Record<"root" | "worker" | AdvisorRole, ReactNode>>;
type AgentNames = Partial<Record<"root" | "worker" | AdvisorRole, string>>;
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
  return <span className="inline-flex h-6 items-center font-medium">Suplex</span>;
}

type StationProps = {
  id: string; x: number; y: number; label: string; caption?: string | undefined; icon: LucideIcon; tone: Tone; sheet: boolean; labelAt: [number, number]; control?: ReactNode; avatar?: ReactNode; active: boolean;
};

function Station({ id, x, y, label, caption, icon: Icon, tone, sheet, labelAt, control, avatar, active }: StationProps) {
  return <g data-illustration-station={id} data-active={active || undefined} aria-current={active ? "step" : undefined}>
    <g className={tones[tone]}>
      {active ? <circle cx={x} cy={y} r="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeOpacity=".7" /> : null}
      {avatar ? null : sheet ? <>
        <rect x={x - 12} y={y - 20} width="32" height="32" rx="5" className="fill-current opacity-10 dark:opacity-20" />
        <rect x={x - 16} y={y - 16} width="32" height="32" rx="5" className="fill-card" stroke="currentColor" strokeOpacity=".65" />
      </> : <>
        <circle cx={x} cy={y} r="22" className="fill-current opacity-10 dark:opacity-20" />
        <circle cx={x} cy={y} r="16" className="fill-card" stroke="currentColor" strokeOpacity=".65" />
      </>}
      {avatar ? null : <Icon x={x - 8} y={y - 8} width="16" height="16" strokeWidth="1.6" aria-hidden="true" />}
    </g>
    {control ? null : <Label x={labelAt[0]} y={labelAt[1]} caption={caption}>{label}</Label>}
  </g>;
}

// WebKit (Tauri) misplaces layered HTML inside <foreignObject>, so avatars and controls sit in an HTML layer over the SVG.
function StationOverlay({ id, x, y, caption, tone, labelAt, control, avatar, viewWidth, viewHeight }: StationProps & { viewWidth: number; viewHeight: number }) {
  const at = (left: number, top: number) => ({ left: `${left / viewWidth * 100}%`, top: `${top / viewHeight * 100}%` });
  return <>
    {avatar ? <div data-illustration-avatar={id} className={`absolute flex size-8 -translate-1/2 items-center justify-center ${tones[tone]}`} style={at(x, y)}>{avatar}</div> : null}
    {control ? <div data-illustration-control={id} className="pointer-events-auto absolute w-40" style={at(Math.max(0, Math.min(viewWidth - 160, labelAt[0] - 80)), labelAt[1] - 14)}>
      <div className="grid min-w-0 justify-items-center p-1 text-center text-xs leading-4">{control}{caption ? <span>{caption}</span> : null}</div>
    </div> : null}
  </>;
}

const stationMeta = {
  objective: { label: "Objective", icon: Crosshair, tone: "source" },
  source: { label: "Pull request", icon: GitPullRequest, tone: "source" },
  plan: { label: "Coordinator", icon: ListChecks, tone: "coordinator", role: "root" },
  approval: { label: "User", caption: "approves the plan", icon: UserRound, tone: "source" },
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
const returnRoutes = new Set(["review-build", "reviewer-build", "repair-rater", "approval-plan"]);
type Layout = (typeof layouts)[WorkflowId]["wide"];

function Flow({ layout, position }: { layout: Layout; position: WorkflowPosition | null }) {
  const ref = useRef<SVGGElement>(null);
  const live = useRef(position);
  live.current = position;
  const following = position !== null;
  useEffect(() => {
    if (!ref.current) return;
    const centers = new Map(layout.nodes.map(node => [node.id, { x: node.x + 22, y: node.y + 22 }]));
    return animateFlow(ref.current, flowEdges(layout, returnRoutes), centers, node => tones[stationMeta[node as StationId].tone], following ? live : undefined);
  }, [layout, following]);
  return <g ref={ref} data-illustration-flow="" aria-hidden="true" pointerEvents="none" />;
}

function routePath(points: readonly Point[]): string {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join("");
}

function artwork({ workflow, delivery, compact, agents, agentNames, avatars, arrowId, author, authorAvatar, pullRequestNumber, position, viewHeight }: { workflow: WorkflowId; delivery: string; compact: boolean; agents: AgentControls; agentNames: AgentNames; avatars: AgentControls; arrowId: string; author: ReactNode; authorAvatar: ReactNode; pullRequestNumber: number | undefined; position: WorkflowPosition | null; viewHeight: number }) {
  const layout = layouts[workflow][compact ? "compact" : "wide"];
  const viewWidth = compact ? 320 : 768;
  const offsetX = (viewWidth - layout.width) / 2;
  const offsetY = compact ? 8 : workflow === "competing_plans" ? 55 : workflow === "refine_pull_request" ? 70 : 20;
  const nodePoints = Object.fromEntries(layout.nodes.map(node => [node.id, { x: node.x + 22 + offsetX, y: node.y + 22 + offsetY }]));
  const stations: StationProps[] = layout.nodes.map(node => {
    const id = node.id as StationId;
    const meta = stationMeta[id];
    const { x, y } = nodePoints[id]!;
    const role = "role" in meta ? meta.role : undefined;
    const deliveryNode = id === "delivery" || id === "merge";
    const control = id === "objective" || id === "approval" ? author : deliveryNode ? <SuplexAgent /> : role ? agents[role] ?? (agentNames[role] ? <span className="inline-flex h-6 items-center font-medium">{agentNames[role]}</span> : undefined) : undefined;
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
      else labelAt = [x + (id === "plan" || id === "approval" || id === "build" || id === "review" || id === "rater" ? -88 : 88), y - 2];
    }
    return { id, x, y, label: id === "source" && pullRequestNumber ? `PR #${pullRequestNumber}` : meta.label, caption, icon: id === "plan" && workflow === "direct_build" ? Send : meta.icon,
      tone: meta.tone, sheet: "sheet" in meta && meta.sheet, labelAt, control,
      avatar: id === "objective" || id === "approval" ? authorAvatar : deliveryNode ? <img src={suplexMark} alt="" className="size-8 invert dark:invert-0" /> : role ? avatars[role] : undefined,
      active: Boolean(position?.targets.includes(id)) };
  });
  return {
    svg: <>
      <g transform={`translate(${offsetX} ${offsetY})`}>
        {flowEdges(layout, returnRoutes).map(edge => {
          const tone = stationMeta[edge.from as StationId].tone;
          return <path key={edge.id} data-illustration-route={edge.id} d={routePath(edge.points)} className={tones[tone]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={edge.returns ? "3 5" : undefined} markerEnd={`url(#${arrowId}-${tone})`} />;
        })}
      </g>
      {stations.map(station => <Station key={station.id} {...station} />)}
      <g transform={`translate(${offsetX} ${offsetY})`}><Flow layout={layout} position={position} /></g>
    </>,
    overlay: stations.map(station => <StationOverlay key={station.id} {...station} viewWidth={viewWidth} viewHeight={viewHeight} />),
  };
}

// Crops each visible layout to its drawn content; the layouts reserve slack for every workflow's label placement.
// It clips the wrapper rather than the viewBox, so the HTML overlay keeps fixed percentages of a fixed viewBox.
function fitToContent(root: HTMLElement): void {
  for (const wrapper of Array.from(root.querySelectorAll<HTMLElement>(":scope > [data-illustration-layout]"))) {
    const canvas = wrapper.firstElementChild as HTMLElement;
    const frame = canvas.getBoundingClientRect();
    if (!frame.height) continue;
    let top = Infinity, bottom = -Infinity;
    for (const element of Array.from(canvas.querySelectorAll("path, circle, rect, text, [data-illustration-avatar], [data-illustration-control] > div"))) {
      if (element.closest("defs, [data-illustration-flow]")) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.height) continue;
      top = Math.min(top, rect.top - frame.top);
      bottom = Math.max(bottom, rect.bottom - frame.top);
    }
    if (top < bottom) {
      wrapper.style.height = `${bottom - top + 8}px`;
      canvas.style.marginTop = `${4 - top}px`;
    }
  }
}

export function WorkflowIllustration({ workflow, delivery, agents = {}, agentNames = {}, avatars = {}, pullRequestNumber, position = null }: { workflow: WorkflowId; delivery: string; agents?: AgentControls; agentNames?: AgentNames; avatars?: AgentControls; pullRequestNumber?: number | undefined; position?: WorkflowPosition | null }) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    // Refit when the panel opens or the wide/compact artwork swaps. Watch the canvases, which the crop does not resize.
    const observer = new ResizeObserver(() => fitToContent(root));
    for (const canvas of Array.from(root.querySelectorAll(":scope > [data-illustration-layout] > div"))) observer.observe(canvas);
    return () => observer.disconnect();
  });
  const user = useOptionalCompanyContext()?.user;
  const author = <span className="inline-flex h-6 items-center font-medium">{user?.displayName ?? "User"}</span>;
  const authorAvatar = user ? <EntityAvatar kind="user" id={user.id} name={user.displayName} seed={user.avatarSeed} size="default" /> : <UserRound className="size-8" />;
  const definition = workflowDefinition(workflow);
  const now = position?.targets.map(target => target in stationMeta ? stationMeta[target as StationId].label : "Coordinator").join(" and ");
  const description = `${definition.steps.join(" ")}${workflow === "approve_then_build" ? " If you request changes, Coordinator revises the plan and asks you again." : ""}${workflow === "refine_pull_request" ? " Coordinator directs repair or delivery after each rating." : " Coordinator can send changes back to Worker after review."} Delivery: ${delivery}.${now ? ` Current step: ${now} (${position!.state}).` : ""}`;
  const deliveryAction = ({
    "Keep in worktree": "keeps changes local",
    "Push branch": "pushes the branch",
    "Draft pull request": "opens a draft PR",
    "Ready for review": "opens a ready PR",
    "Merge to base": "merges the PR",
    "Merged pull request": "merges the PR",
  } as Record<string, string>)[delivery] ?? delivery;
  return <div ref={container} className="@container" data-workflow-illustration={workflow}>
    {[false, true].map(compact => {
      const layout = layouts[workflow][compact ? "compact" : "wide"];
      const height = layout.height + (compact ? 78 : workflow === "refine_pull_request" ? 160 : 110);
      const arrowId = `${id.replaceAll(":", "")}-${compact}-arrow`;
      const art = artwork({ workflow, delivery: deliveryAction, compact, agents, agentNames, avatars, arrowId, author, authorAvatar, pullRequestNumber, position, viewHeight: height });
      return <div key={String(compact)} data-illustration-layout={compact ? "compact" : "wide"} className={compact ? "mx-auto block w-full max-w-80 overflow-hidden @min-[640px]:hidden" : "mx-auto hidden w-full max-w-3xl overflow-hidden @min-[640px]:block"}
        role={Object.keys(agents).length || Object.keys(agentNames).length ? "group" : "img"}
        aria-labelledby={`${id}-${compact}-title`} aria-describedby={`${id}-${compact}-description`}>
        <div className="relative">
          <svg className="block w-full" viewBox={`0 0 ${compact ? 320 : 768} ${height}`}>
            <title id={`${id}-${compact}-title`}>{`${definition.name} workflow`}</title>
            <desc id={`${id}-${compact}-description`}>{description}</desc>
            <defs>{(Object.entries(tones) as [Tone, string][]).map(([tone, className]) =>
              <marker key={tone} id={`${arrowId}-${tone}`} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 8 4 0 8z" className={className} fill="currentColor" /></marker>)}</defs>
            {art.svg}
          </svg>
          <div className="pointer-events-none absolute inset-0">{art.overlay}</div>
        </div>
      </div>;
    })}
  </div>;
}
