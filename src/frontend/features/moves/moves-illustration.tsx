import type { ReactElement } from "react";
import { Zap } from "lucide-react";

import { Anim, Bead, fanRoute, Glow, held, keyTimes, NODE, Pulse, SceneIllustration, type Scene, type SceneProps } from "../../components/app/scene-illustration.js";

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

export function MovesIllustration(): ReactElement {
  return <SceneIllustration scenes={SCENES} icon={Zap} label="Moves" />;
}
