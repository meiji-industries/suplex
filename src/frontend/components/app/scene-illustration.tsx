import { useEffect, useId, useRef, useState, type ComponentType, type ReactElement } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils.js";

// A few scenes share one stage. The centre node stays still while each scene plays once, then the next slides in.
// Every timing is a fraction of its scene's loop, so the elements of a scene share one clock.
export const NODE = { x: 44, y: 82 };
const TRANSITION_MS = 520;

export type SceneProps = { id: string; still: boolean };
export type Scene = { label: string; loop: number; Scene: ComponentType<SceneProps> };

export const keyTimes = (...times: number[]): string => times.map(time => time.toFixed(3)).join(";");

/** SMIL drops an animation whose key times do not end at 1, so the last value holds until then. */
export function held<T>(values: T[], times: number[]): { values: T[]; times: number[] } {
  return times.at(-1) === 1 ? { values, times } : { values: [...values, values.at(-1)!], times: [...times, 1] };
}
export const fanRoute = (y: number): string => `M${NODE.x + 20} ${NODE.y} C130 ${NODE.y}, 130 ${y}, 196 ${y}`;

/** An animated attribute. With reduced motion it jumps to its final value. */
export function Anim({ attr, values, times, loop, still, final }: { attr: string; values: (string | number)[]; times: number[]; loop: number; still: boolean; final: string | number }): ReactElement {
  return still
    ? <set attributeName={attr} to={String(final)} />
    : <animate attributeName={attr} dur={`${loop}s`} fill="freeze" values={held(values, times).values.join(";")} keyTimes={keyTimes(...held(values, times).times)} />;
}

export function Pulse({ loop, still, at }: { loop: number; still: boolean; at: number[] }): ReactElement {
  const values = at.flatMap(() => [20, 27, 20]);
  const opacity = at.flatMap(() => [0.12, 0.3, 0.12]);
  const times = at.flatMap(time => [time, time + 0.05, time + 0.12]);
  return <circle cx={NODE.x} cy={NODE.y} r="20" fill="currentColor" opacity="0.12" className="text-primary">
    {still ? null : <animate attributeName="r" dur={`${loop}s`} fill="freeze" values={[20, ...values, 20].join(";")} keyTimes={keyTimes(0, ...times, 1)} />}
    {still ? null : <animate attributeName="opacity" dur={`${loop}s`} fill="freeze" values={[0.12, ...opacity, 0.12].join(";")} keyTimes={keyTimes(0, ...times, 1)} />}
  </circle>;
}

export function Bead({ route, start, travel, loop, still, glow }: { route: string; start: number; travel: number; loop: number; still: boolean; glow: string }): ReactElement | null {
  if (still) return null;
  return <g className="text-primary">
    {[{ r: 7, filter: `url(#${glow})`, opacity: 0.7 }, { r: 3, filter: undefined, opacity: 1 }].map(bead => <circle key={bead.r} r={bead.r} fill="currentColor" filter={bead.filter} opacity="0">
      <animateMotion dur={`${loop}s`} fill="freeze" calcMode="spline" keyPoints="0;0;1;1" keyTimes={keyTimes(0, start, start + travel, 1)} keySplines="0 0 1 1;0.45 0 0.2 1;0 0 1 1"><mpath href={`#${route}`} /></animateMotion>
      <animate attributeName="opacity" dur={`${loop}s`} fill="freeze" values={`0;0;${bead.opacity};${bead.opacity};0;0`} keyTimes={keyTimes(0, start, start + 0.01, start + travel - 0.01, start + travel, 1)} />
    </circle>)}
  </g>;
}

export function Glow({ id }: { id: string }): ReactElement {
  return <defs><filter id={id} x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="3" /></filter></defs>;
}


function reducedMotion(): boolean {
  return typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
/** Animated carousel of scenes around one centre node. Arrow keys, swipe, and the dots change the scene. */
export function SceneIllustration({ scenes, icon: Icon, label }: { scenes: readonly Scene[]; icon: LucideIcon; label: string }): ReactElement {
  const id = useId();
  const [still] = useState(reducedMotion);
  const [stage, setStage] = useState({ index: 0, runs: scenes.map((_, index) => index) });
  const swipe = useRef<number | null>(null);
  const show = (next: number): void => setStage(current => {
    const index = (next + scenes.length) % scenes.length;
    if (index === current.index) return current;
    return { index, runs: current.runs.map((run, scene) => scene === index ? Math.max(...current.runs) + 1 : run) };
  });
  useEffect(() => {
    if (still) return;
    const timer = window.setTimeout(() => show(stage.index + 1), scenes[stage.index]!.loop * 1000);
    return () => window.clearTimeout(timer);
  }, [stage, still]);
  return <div
    role="group"
    aria-roledescription="carousel"
    aria-label={label}
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
      {scenes.map(({ label, Scene }, index) => {
        const offset = (index - stage.index + scenes.length) % scenes.length;
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
          <Icon x={NODE.x - 9} y={NODE.y - 9} width={18} height={18} strokeWidth={1.5} />
        </g>
      </svg>
    </div>
    <div className="flex items-center gap-1.5">
      {scenes.map(({ label }, index) => <button
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
