import type { ReactElement } from "react";
import { ClipboardList, GitBranch, GitMerge, ScanEye, Terminal } from "lucide-react";

import { Anim, Bead, fanRoute, Glow, NODE, Pulse, SceneIllustration, type Scene, type SceneProps } from "../../components/app/scene-illustration.js";

const WORKTREE_LOOP = 5.2;
const WORKTREES = [
  { number: 12, y: 44, start: 0.06 },
  { number: 13, y: 82, start: 0.14 },
  { number: 14, y: 120, start: 0.22 },
] as const;

/** Every task gets its own worktree. */
function WorktreeScene({ id, still }: SceneProps): ReactElement {
  const loop = WORKTREE_LOOP;
  return <>
    <Glow id={`${id}-glow`} />
    <Pulse loop={loop} still={still} at={[0]} />
    {WORKTREES.map(row => <path key={row.number} id={`${id}-route-${row.number}`} d={fanRoute(row.y)} fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 4" strokeLinecap="round" className="text-border" />)}
    {WORKTREES.map(row => {
      const arrive = row.start + 0.16;
      return <g key={row.number}>
        <rect x="196" y={row.y - 13} width="148" height="26" rx="6" fill="none" stroke="currentColor" className="text-border" />
        <GitBranch x={204} y={row.y - 6} width={12} height={12} strokeWidth={1.5} className="text-muted-foreground" />
        <circle cx="331" cy={row.y} r="4.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 2" className="text-muted-foreground" />
        <circle cx="331" cy={row.y} r="0" fill="currentColor" className="text-primary">
          <Anim attr="r" loop={loop} still={still} final={4.5} values={[0, 0, 6, 4.5]} times={[0, arrive, arrive + 0.03, arrive + 0.06]} />
        </circle>
        <text x="222" y={row.y + 4} fontSize="11" fill="currentColor" className="text-muted-foreground">task/{row.number}</text>
        <rect x="268" y={row.y - 3} width={52 - (row.number % 3) * 10} height="6" rx="3" fill="currentColor" className="text-muted" />
      </g>;
    })}
    {WORKTREES.map(row => <Bead key={row.number} route={`${id}-route-${row.number}`} start={row.start} travel={0.16} loop={loop} still={still} glow={`${id}-glow`} />)}
  </>;
}

const AGENT_LOOP = 6;
const COORDINATOR = { x: 140, start: 0.05 };
const WORKER = { x: 232, start: 0.24 };
const PULL_REQUEST = { x: 282, start: 0.44 };
const HOP = 0.12;

/** A Coordinator plans, a Worker builds, and a pull request opens. */
function AgentScene({ id, still }: SceneProps): ReactElement {
  const loop = AGENT_LOOP;
  const y = NODE.y;
  const agents = [
    { key: "coordinator", x: COORDINATOR.x, label: "Coordinator", Icon: ScanEye, tone: "text-violet-600 dark:text-violet-400", arrive: COORDINATOR.start + HOP },
    { key: "worker", x: WORKER.x, label: "Worker", Icon: Terminal, tone: "text-teal-700 dark:text-teal-400", arrive: WORKER.start + HOP },
  ] as const;
  const routes = [
    { key: "coordinator", d: `M${NODE.x + 20} ${y} L${COORDINATOR.x - 16} ${y}`, start: COORDINATOR.start },
    { key: "worker", d: `M${COORDINATOR.x + 16} ${y} L${WORKER.x - 16} ${y}`, start: WORKER.start },
    { key: "pull-request", d: `M${WORKER.x + 16} ${y} L${PULL_REQUEST.x} ${y}`, start: PULL_REQUEST.start },
  ] as const;
  const opened = PULL_REQUEST.start + HOP;
  return <>
    <Glow id={`${id}-glow`} />
    <Pulse loop={loop} still={still} at={[0]} />
    {routes.map(route => <path key={route.key} id={`${id}-route-${route.key}`} d={route.d} fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 4" strokeLinecap="round" className="text-border" />)}
    {agents.map(agent => <g key={agent.key} className={agent.tone}>
      <circle cx={agent.x} cy={y} r="16" fill="currentColor" className="fill-background" />
      <circle cx={agent.x} cy={y} r="16" fill="none" stroke="currentColor" strokeWidth="1.25" className="text-border" />
      <circle cx={agent.x} cy={y} r="16" fill="none" stroke="currentColor" strokeWidth="1.25" opacity="0">
        <Anim attr="opacity" loop={loop} still={still} final={0.8} values={[0, 0, 0.8, 0.8]} times={[0, agent.arrive, agent.arrive + 0.03, 1]} />
      </circle>
      <agent.Icon x={agent.x - 7} y={y - 7} width={14} height={14} strokeWidth={1.5} />
      <text x={agent.x} y={y + 30} fontSize="10" textAnchor="middle" fill="currentColor" className="text-muted-foreground">{agent.label}</text>
    </g>)}
    <rect x={PULL_REQUEST.x} y={y - 13} width="62" height="26" rx="6" fill="none" stroke="currentColor" className="text-border" />
    <circle cx={PULL_REQUEST.x + 14} cy={y} r="4.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 2" className="text-muted-foreground" />
    <circle cx={PULL_REQUEST.x + 14} cy={y} r="0" fill="currentColor" className="text-primary">
      <Anim attr="r" loop={loop} still={still} final={4.5} values={[0, 0, 6, 4.5]} times={[0, opened, opened + 0.03, opened + 0.06]} />
    </circle>
    <text x={PULL_REQUEST.x + 26} y={y + 4} fontSize="11" fill="currentColor" className="text-muted-foreground">#42</text>
    {routes.map(route => <Bead key={route.key} route={`${id}-route-${route.key}`} start={route.start} travel={HOP} loop={loop} still={still} glow={`${id}-glow`} />)}
  </>;
}

const DELIVERY_LOOP = 5.6;
const CARD_Y = 58;
const CHECKS = [0.3, 0.4, 0.5] as const;
const MERGED = 0.64;

/** CI checks pass and Suplex merges the pull request. */
function DeliveryScene({ id, still }: SceneProps): ReactElement {
  const loop = DELIVERY_LOOP;
  const opened = 0.06 + 0.16;
  return <>
    <Glow id={`${id}-glow`} />
    <Pulse loop={loop} still={still} at={[0]} />
    <path id={`${id}-route`} d={fanRoute(CARD_Y)} fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 4" strokeLinecap="round" className="text-border" />
    <rect x="196" y={CARD_Y - 13} width="148" height="26" rx="6" fill="none" stroke="currentColor" className="text-border" />
    <circle cx="211" cy={CARD_Y} r="4.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 2" className="text-muted-foreground" />
    <circle cx="211" cy={CARD_Y} r="0" fill="currentColor" className="text-primary">
      <Anim attr="r" loop={loop} still={still} final={4.5} values={[0, 0, 6, 4.5]} times={[0, opened, opened + 0.03, opened + 0.06]} />
    </circle>
    <text x="224" y={CARD_Y + 4} fontSize="11" fill="currentColor" className="text-muted-foreground">#42</text>
    <rect x="250" y={CARD_Y - 3} width="78" height="6" rx="3" fill="currentColor" className="text-muted" />
    <text x="196" y={CARD_Y + 36} fontSize="10" fill="currentColor" className="text-muted-foreground">Checks</text>
    {CHECKS.map((at, index) => <g key={at}>
      <circle cx={240 + index * 18} cy={CARD_Y + 32} r="4.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 2" className="text-muted-foreground" />
      <circle cx={240 + index * 18} cy={CARD_Y + 32} r="0" fill="currentColor" className="text-primary">
        <Anim attr="r" loop={loop} still={still} final={4.5} values={[0, 0, 6, 4.5]} times={[0, at, at + 0.03, at + 0.06]} />
      </circle>
    </g>)}
    <g className="text-primary" opacity="0">
      <Anim attr="opacity" loop={loop} still={still} final={1} values={[0, 0, 1, 1]} times={[0, MERGED, MERGED + 0.05, 1]} />
      <GitMerge x={196} y={CARD_Y + 54} width={14} height={14} strokeWidth={1.5} />
      <text x="216" y={CARD_Y + 65} fontSize="11" fill="currentColor" className="text-foreground">Merged</text>
    </g>
    <Bead route={`${id}-route`} start={0.06} travel={0.16} loop={loop} still={still} glow={`${id}-glow`} />
  </>;
}

const SCENES: readonly Scene[] = [
  { label: "A task gets its own worktree", loop: WORKTREE_LOOP, Scene: WorktreeScene },
  { label: "A Coordinator plans and a Worker builds", loop: AGENT_LOOP, Scene: AgentScene },
  { label: "Suplex delivers the pull request", loop: DELIVERY_LOOP, Scene: DeliveryScene },
];

export function TasksIllustration(): ReactElement {
  return <SceneIllustration scenes={SCENES} icon={ClipboardList} label="Tasks" />;
}
