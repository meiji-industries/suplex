import { useEffect, useId, useRef, useState, type ComponentType, type ReactElement } from "react";
import { Zap } from "lucide-react";

import { cn } from "../../lib/utils.js";

// Three scenes share one stage. The move node stays still while each scene plays once, then the next slides in.
// Every timing is a fraction of its scene's loop, so the elements of a scene share one clock.
const NODE = { x: 44, y: 82 };
const TRANSITION_MS = 520;

type SceneProps = { id: string; still: boolean };
type Scene = { label: string; loop: number; Scene: ComponentType<SceneProps> };

const keyTimes = (...times: number[]): string => times.map(time => time.toFixed(3)).join(";");

/** SMIL drops an animation whose key times do not end at 1, so the last value holds until then. */
function held<T>(values: T[], times: number[]): { values: T[]; times: number[] } {
  return times.at(-1) === 1 ? { values, times } : { values: [...values, values.at(-1)!], times: [...times, 1] };
}
const fanRoute = (y: number): string => `M${NODE.x + 20} ${NODE.y} C130 ${NODE.y}, 130 ${y}, 196 ${y}`;

/** An animated attribute. With reduced motion it jumps to its final value. */
function Anim({ attr, values, times, loop, still, final }: { attr: string; values: (string | number)[]; times: number[]; loop: number; still: boolean; final: string | number }): ReactElement {
  return still
    ? <set attributeName={attr} to={String(final)} />
    : <animate attributeName={attr} dur={`${loop}s`} fill="freeze" values={held(values, times).values.join(";")} keyTimes={keyTimes(...held(values, times).times)} />;
}

function Pulse({ loop, still, at }: { loop: number; still: boolean; at: number[] }): ReactElement {
  const values = at.flatMap(() => [20, 27, 20]);
  const opacity = at.flatMap(() => [0.12, 0.3, 0.12]);
  const times = at.flatMap(time => [time, time + 0.05, time + 0.12]);
  return <circle cx={NODE.x} cy={NODE.y} r="20" fill="currentColor" opacity="0.12" className="text-primary">
    {still ? null : <animate attributeName="r" dur={`${loop}s`} fill="freeze" values={[20, ...values, 20].join(";")} keyTimes={keyTimes(0, ...times, 1)} />}
    {still ? null : <animate attributeName="opacity" dur={`${loop}s`} fill="freeze" values={[0.12, ...opacity, 0.12].join(";")} keyTimes={keyTimes(0, ...times, 1)} />}
  </circle>;
}

function Bead({ route, start, travel, loop, still, glow }: { route: string; start: number; travel: number; loop: number; still: boolean; glow: string }): ReactElement | null {
  if (still) return null;
  return <g className="text-primary">
    {[{ r: 7, filter: `url(#${glow})`, opacity: 0.7 }, { r: 3, filter: undefined, opacity: 1 }].map(bead => <circle key={bead.r} r={bead.r} fill="currentColor" filter={bead.filter} opacity="0">
      <animateMotion dur={`${loop}s`} fill="freeze" calcMode="spline" keyPoints="0;0;1;1" keyTimes={keyTimes(0, start, start + travel, 1)} keySplines="0 0 1 1;0.45 0 0.2 1;0 0 1 1"><mpath href={`#${route}`} /></animateMotion>
      <animate attributeName="opacity" dur={`${loop}s`} fill="freeze" values={`0;0;${bead.opacity};${bead.opacity};0;0`} keyTimes={keyTimes(0, start, start + 0.01, start + travel - 0.01, start + travel, 1)} />
    </circle>)}
  </g>;
}

function Glow({ id }: { id: string }): ReactElement {
  return <defs><filter id={id} x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="3" /></filter></defs>;
}

const PULL_REQUEST_LOOP = 5.2;
const PULL_REQUESTS = [
  { number: 12, y: 30, start: 0.06 },
  { number: 13, y: 64, start: 0.12 },
  { number: 14, y: 98, start: null },
  { number: 15, y: 132, start: 0.18 },
] as const;

function PullRequestScene({ id, still }: SceneProps): ReactElement {
  const loop = PULL_REQUEST_LOOP;
  return <>
    <Glow id={`${id}-glow`} />
    <Pulse loop={loop} still={still} at={[0]} />
    {PULL_REQUESTS.map(row => <path key={row.number} id={`${id}-route-${row.number}`} d={fanRoute(row.y)} fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 4" strokeLinecap="round" className={row.start === null ? "text-border opacity-50" : "text-border"} />)}
    {PULL_REQUESTS.map(row => {
      const excluded = row.start === null;
      const arrive = (row.start ?? 0) + 0.16;
      return <g key={row.number} opacity={excluded ? 0.4 : 1}>
        <rect x="196" y={row.y - 13} width="148" height="26" rx="6" fill="none" stroke="currentColor" strokeDasharray={excluded ? "3 3" : undefined} className="text-border" />
        <circle cx="211" cy={row.y} r="4.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 2" className="text-muted-foreground" />
        {excluded ? <line x1="208" y1={row.y} x2="214" y2={row.y} stroke="currentColor" strokeWidth="1.25" className="text-muted-foreground" /> : <circle cx="211" cy={row.y} r="0" fill="currentColor" className="text-primary">
          <Anim attr="r" loop={loop} still={still} final={4.5} values={[0, 0, 6, 4.5]} times={[0, arrive, arrive + 0.03, arrive + 0.06]} />
        </circle>}
        <text x="224" y={row.y + 4} fontSize="11" fill="currentColor" className="text-muted-foreground">#{row.number}</text>
        <rect x="250" y={row.y - 3} width={excluded ? 54 : 78 - (row.number % 3) * 12} height="6" rx="3" fill="currentColor" className="text-muted" />
      </g>;
    })}
    {PULL_REQUESTS.map(row => row.start === null ? null : <Bead key={row.number} route={`${id}-route-${row.number}`} start={row.start} travel={0.16} loop={loop} still={still} glow={`${id}-glow`} />)}
  </>;
}

const RELEASE_LOOP = 5.6;
const TAG = { x: 112, y: 70, width: 64, height: 24 };
const PHONES = [{ x: 246, start: 0.26 }, { x: 290, start: 0.32 }, { x: 334, start: 0.38 }] as const;
const TAG_ARRIVE = 0.18;

function ReleaseScene({ id, still }: SceneProps): ReactElement {
  const loop = RELEASE_LOOP;
  const tagEnd = TAG.x + TAG.width;
  return <>
    <Glow id={`${id}-glow`} />
    <Pulse loop={loop} still={still} at={[0]} />
    <path id={`${id}-tag`} d={`M${NODE.x + 20} ${NODE.y} L${TAG.x} ${NODE.y}`} fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 4" strokeLinecap="round" className="text-border" />
    {PHONES.map(phone => <path key={phone.x} id={`${id}-phone-${phone.x}`} d={`M${tagEnd} ${NODE.y} C${tagEnd + 24} ${NODE.y}, ${phone.x - 18} 26, ${phone.x} 47`} fill="none" stroke="none" />)}
    <rect x={TAG.x} y={TAG.y} width={TAG.width} height={TAG.height} rx="12" fill="none" stroke="currentColor" className="text-border" />
    <rect x={TAG.x} y={TAG.y} width={TAG.width} height={TAG.height} rx="12" fill="none" stroke="currentColor" opacity="0" className="text-primary">
      <Anim attr="opacity" loop={loop} still={still} final={1} values={[0, 0, 1, 1]} times={[0, TAG_ARRIVE, TAG_ARRIVE + 0.03, 1]} />
    </rect>
    <text x={TAG.x + TAG.width / 2} y={NODE.y + 4} fontSize="11" textAnchor="middle" fill="currentColor" className="text-muted-foreground">
      v2.3.1
      <Anim attr="opacity" loop={loop} still={still} final={0} values={[1, 1, 0, 0]} times={[0, TAG_ARRIVE - 0.02, TAG_ARRIVE + 0.02, 1]} />
    </text>
    <text x={TAG.x + TAG.width / 2} y={NODE.y + 4} fontSize="11" textAnchor="middle" fill="currentColor" opacity="0" className="text-foreground">
      v2.4.0
      <Anim attr="opacity" loop={loop} still={still} final={1} values={[0, 0, 1, 1]} times={[0, TAG_ARRIVE - 0.01, TAG_ARRIVE + 0.03, 1]} />
    </text>
    {PHONES.map(phone => {
      const arrive = phone.start + 0.14;
      return <g key={phone.x}>
        <rect x={phone.x - 17} y="47" width="34" height="66" rx="7" fill="none" stroke="currentColor" className="text-border" />
        <rect x={phone.x - 13} y="53" width="26" height="54" rx="3" fill="currentColor" className="text-muted" opacity="0.5" />
        <line x1={phone.x - 4} y1="50" x2={phone.x + 4} y2="50" stroke="currentColor" strokeLinecap="round" className="text-border" />
        <rect x={phone.x - 9} y="96" width="0" height="3" rx="1.5" fill="currentColor" className="text-primary">
          <Anim attr="width" loop={loop} still={still} final={18} values={[0, 0, 18, 18]} times={[0, arrive, arrive + 0.12, 1]} />
          <Anim attr="opacity" loop={loop} still={still} final={0} values={[1, 1, 1, 0, 0]} times={[0, arrive, arrive + 0.13, arrive + 0.17, 1]} />
        </rect>
        <g transform={`translate(${phone.x} 76)`}>
          <rect x="-7" y="-7" width="14" height="14" rx="4" fill="currentColor" className="text-primary" transform={still ? undefined : "scale(0)"}>
            {still ? null : <animateTransform attributeName="transform" type="scale" dur={`${loop}s`} fill="freeze" values="0;0;1.3;1;1" keyTimes={keyTimes(0, arrive + 0.13, arrive + 0.17, arrive + 0.2, 1)} />}
          </rect>
        </g>
      </g>;
    })}
    <Bead route={`${id}-tag`} start={0.06} travel={TAG_ARRIVE - 0.06} loop={loop} still={still} glow={`${id}-glow`} />
    {PHONES.map(phone => <Bead key={phone.x} route={`${id}-phone-${phone.x}`} start={phone.start} travel={0.14} loop={loop} still={still} glow={`${id}-glow`} />)}
  </>;
}

const HISTORY_LOOP = 6;
const RUNS = [
  { input: "patch", start: 0.04 },
  { input: "minor", start: 0.3 },
  { input: "major", start: 0.56 },
] as const;
const SLOT = 34;
const TOP = 30;

function HistoryScene({ id, still }: SceneProps): ReactElement {
  const loop = HISTORY_LOOP;
  const arrivals = RUNS.map(run => run.start + 0.12);
  return <>
    <Glow id={`${id}-glow`} />
    <Pulse loop={loop} still={still} at={RUNS.map(run => run.start - 0.03)} />
    <path id={`${id}-route`} d={fanRoute(TOP)} fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 4" strokeLinecap="round" className="text-border" />
    {[0, 1, 2, 3].map(slot => <rect key={slot} x="196" y={TOP + slot * SLOT - 13} width="148" height="26" rx="6" fill="none" stroke="currentColor" strokeDasharray="3 3" className="text-border" opacity="0.35" />)}
    {RUNS.map((run, index) => {
      const later = arrivals.slice(index + 1);
      const shifts = later.flatMap((time, step) => [time - 0.02, time + 0.04].map((at, edge) => ({ at, y: SLOT * (step + edge) })));
      const { values, times } = held(["0 -10", "0 -10", "0 0", ...shifts.map(shift => `0 ${shift.y}`)], [0, arrivals[index]! - 0.01, arrivals[index]! + 0.04, ...shifts.map(shift => shift.at)]);
      const finalY = SLOT * (RUNS.length - 1 - index);
      return <g key={run.input} transform={`translate(0 ${still ? finalY : -10})`} opacity="0">
        {still ? null : <animateTransform attributeName="transform" type="translate" dur={`${loop}s`} fill="freeze" calcMode="spline" values={values.join(";")} keyTimes={keyTimes(...times)} keySplines={times.slice(1).map(() => "0.3 0 0.2 1").join(";")} />}
        <Anim attr="opacity" loop={loop} still={still} final={1} values={[0, 0, 1, 1]} times={[0, arrivals[index]! - 0.01, arrivals[index]! + 0.03, 1]} />
        <rect x="196" y={TOP - 13} width="148" height="26" rx="6" fill="currentColor" stroke="currentColor" className="fill-background text-border" />
        <circle cx="211" cy={TOP} r="0" fill="currentColor" className="text-primary">
          <Anim attr="r" loop={loop} still={still} final={4.5} values={[0, 0, 6, 4.5]} times={[0, arrivals[index]! + 0.06, arrivals[index]! + 0.09, arrivals[index]! + 0.12]} />
        </circle>
        <rect x="223" y={TOP - 8} width="42" height="16" rx="8" fill="none" stroke="currentColor" className="text-border" />
        <text x="244" y={TOP + 4} fontSize="10" textAnchor="middle" fill="currentColor" className="text-foreground">{run.input}</text>
        <rect x="274" y={TOP - 3} width={56 - index * 8} height="6" rx="3" fill="currentColor" className="text-muted" />
      </g>;
    })}
    {RUNS.map(run => <Bead key={run.input} route={`${id}-route`} start={run.start} travel={0.12} loop={loop} still={still} glow={`${id}-glow`} />)}
  </>;
}

const SCENES: readonly Scene[] = [
  { label: "A move starts a task for each pull request", loop: PULL_REQUEST_LOOP, Scene: PullRequestScene },
  { label: "A move ships a release to phones", loop: RELEASE_LOOP, Scene: ReleaseScene },
  { label: "Each start of a move adds a run to its history", loop: HISTORY_LOOP, Scene: HistoryScene },
];

function reducedMotion(): boolean {
  return typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function MovesIllustration(): ReactElement {
  const id = useId();
  const [still] = useState(reducedMotion);
  const [stage, setStage] = useState({ index: 0, runs: SCENES.map((_, index) => index) });
  const swipe = useRef<number | null>(null);
  const show = (next: number): void => setStage(current => {
    const index = (next + SCENES.length) % SCENES.length;
    if (index === current.index) return current;
    return { index, runs: current.runs.map((run, scene) => scene === index ? Math.max(...current.runs) + 1 : run) };
  });
  useEffect(() => {
    if (still) return;
    const timer = window.setTimeout(() => show(stage.index + 1), SCENES[stage.index]!.loop * 1000);
    return () => window.clearTimeout(timer);
  }, [stage, still]);
  return <div
    role="group"
    aria-roledescription="carousel"
    aria-label="Moves"
    tabIndex={0}
    className="flex w-full max-w-sm touch-pan-y select-none flex-col items-center gap-3 outline-none"
    onKeyDown={event => { if (event.key === "ArrowRight") show(stage.index + 1); if (event.key === "ArrowLeft") show(stage.index - 1); }}
    onPointerDown={event => { swipe.current = event.clientX; }}
    onPointerUp={event => {
      const start = swipe.current;
      swipe.current = null;
      if (start === null || Math.abs(event.clientX - start) < 40) return;
      show(stage.index + (event.clientX < start ? 1 : -1));
    }}
  >
    <div className="grid w-full">
      {SCENES.map(({ label, Scene }, index) => {
        const offset = (index - stage.index + SCENES.length) % SCENES.length;
        return <svg
          key={`${index}:${stage.runs[index]}`}
          viewBox="0 0 360 164"
          role="img"
          aria-label={label}
          aria-hidden={offset !== 0}
          style={{ transitionDuration: `${TRANSITION_MS}ms` }}
          className={cn("col-start-1 row-start-1 w-full transition-[opacity,translate] ease-out motion-reduce:transition-none", offset === 0 ? "translate-x-0 opacity-100" : offset === 1 ? "translate-x-6 opacity-0" : "-translate-x-6 opacity-0")}
        >
          <Scene id={`${id}-${index}`} still={still} />
        </svg>;
      })}
      <svg viewBox="0 0 360 164" aria-hidden="true" className="pointer-events-none col-start-1 row-start-1 w-full">
        <g className="text-primary">
          <circle cx={NODE.x} cy={NODE.y} r="20" fill="currentColor" className="fill-background" />
          <circle cx={NODE.x} cy={NODE.y} r="20" fill="none" stroke="currentColor" strokeWidth="1.25" opacity="0.6" />
          <Zap x={NODE.x - 9} y={NODE.y - 9} width={18} height={18} strokeWidth={1.5} />
        </g>
      </svg>
    </div>
    <div className="flex items-center gap-1.5">
      {SCENES.map(({ label }, index) => <button
        key={label}
        type="button"
        aria-label={label}
        aria-current={index === stage.index}
        onClick={() => show(index)}
        className={cn("h-1.5 rounded-full transition-all duration-300 motion-reduce:transition-none", index === stage.index ? "w-4 bg-primary" : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/60")}
      />)}
    </div>
  </div>;
}
