// A token that travels a workflow illustration. Without a live position it loops every route as decoration;
// with one it follows the task's observed position.
import type { WorkflowPosition } from "./workflow-position.js";
type Point = { x: number; y: number };
type Layout = { nodes: readonly { id: string; x: number; y: number }[]; edges: readonly { id: string; points: readonly Point[] }[] };
export type FlowEdge = { id: string; from: string; to: string; returns: boolean; points: readonly Point[] };

export function flowEdges(layout: Layout, returns: ReadonlySet<string>): FlowEdge[] {
  const ids = layout.nodes.map(node => node.id);
  return layout.edges.map(edge => {
    const from = ids.find(id => edge.id.startsWith(`${id}-`) && ids.includes(edge.id.slice(id.length + 1)))!;
    return { id: edge.id, from, to: edge.id.slice(from.length + 1), returns: returns.has(edge.id), points: edge.points };
  });
}

// Orders every edge into waves of simultaneous moves. Parallel branches fork the token and rejoin it,
// return loops run before the exit, and edges into a terminal station wait until nothing else is left.
export function planFlow(edges: readonly FlowEdge[]): FlowEdge[][] {
  const terminal = (node: string) => !edges.some(edge => edge.from === node);
  const visited = new Set<FlowEdge>();
  const eligible = (edge: FlowEdge) => !visited.has(edge) && (!terminal(edge.to) || edges.every(other => visited.has(other) || terminal(other.to)));
  const towardWork = (start: string): FlowEdge[] => {
    const via = new Map<string, FlowEdge>();
    const queue = [start];
    for (const node of queue) {
      if (node !== start && edges.some(edge => edge.from === node && eligible(edge))) {
        let step = via.get(node)!;
        while (step.from !== start) step = via.get(step.from)!;
        return [step];
      }
      for (const edge of edges) if (edge.from === node && edge.to !== start && !via.has(edge.to)) {
        via.set(edge.to, edge);
        queue.push(edge.to);
      }
    }
    return [];
  };
  let at = [...new Set(edges.map(edge => edge.from).filter(node => !edges.some(edge => edge.to === node)))];
  const waves: FlowEdge[][] = [];
  while (at.some(node => !terminal(node)) && waves.length < 64) {
    const wave = at.flatMap(node => {
      const options = edges.filter(edge => edge.from === node && eligible(edge));
      if (options.length > 1 && options.every(edge => !edge.returns)) return options;
      if (options.length) return [options.find(edge => edge.returns) ?? options[0]!];
      return towardWork(node);
    });
    if (!wave.length) break;
    for (const edge of wave) visited.add(edge);
    waves.push(wave);
    at = [...new Set(wave.map(edge => edge.to))];
  }
  return waves;
}

const NS = "http://www.w3.org/2000/svg";
const RING = 22; // station halo radius
// Tuning knobs: travel is a thrust-limited particle; the drawn orb trails it on an underdamped spring.
const MAX_SPEED = 190, THRUST = 900, BRAKE = 420, RESPONSE = 16;
const SPRING = 520, DAMPING = 2 * Math.sqrt(SPRING) * 0.55;
const DWELL = 0.24, REST = 3.6, TAIL = 16, RADIUS = 3.5, PASSES = 2; // the demo plays PASSES times, then rests
const ORBIT = 1.1, HOLD = 0.5; // live mode: halo orbit speed (rad/s) while working; where on a route the token waits

type Leg = { points: Point[]; lengths: number[]; edge: FlowEdge | undefined; edgeStart: number; edgeLength: number; hold?: number };
type Orb = {
  node: string; angle: number | null; leg: Leg | null; s: number; v: number; hit: boolean; dying: boolean; scale: number;
  target: Point; p: Point; pv: Point; trail: Point[]; body: SVGGElement; shape: SVGEllipseElement; tail: SVGGElement;
  queue: FlowEdge[]; stop: string | undefined; merging: boolean; fading: boolean;
};
type Spark = { element: SVGCircleElement; p: Point; v: Point; age: number; life: number };
type Ripple = { element: SVGCircleElement; age: number; life: number; from: number; to: number };

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  parent.append(element);
  return element;
}

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const angleOf = (center: Point, point: Point) => Math.atan2(point.y - center.y, point.x - center.x);

function measure(points: Point[], edge?: FlowEdge, lead = 0): Leg {
  const lengths = [0];
  for (let index = 1; index < points.length; index++) lengths.push(lengths[index - 1]! + distance(points[index - 1]!, points[index]!));
  const edgeStart = lengths[lead] ?? 0;
  return { points, lengths, edge, edgeStart, edgeLength: edge ? lengths[lead + edge.points.length - 1]! - edgeStart : 0 };
}

function pointAt(leg: Leg, s: number): Point {
  const { points, lengths } = leg;
  let index = 1;
  while (index < points.length - 1 && lengths[index]! < s) index++;
  const a = points[index - 1] ?? points[0]!, b = points[index] ?? a;
  const span = lengths[index]! - lengths[index - 1]!;
  const t = span ? Math.min(1, Math.max(0, (s - lengths[index - 1]!) / span)) : 1;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Points around a station halo, taking the shorter way from one angle to another.
function arc(center: Point, from: number, to: number): Point[] {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  const steps = Math.ceil(Math.abs(delta) / 0.15);
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = from + delta * index / steps;
    return { x: center.x + RING * Math.cos(angle), y: center.y + RING * Math.sin(angle) };
  });
}

// Shortest route between two stations, or null when the diagram has none.
export function route(edges: readonly FlowEdge[], from: string, to: string): FlowEdge[] | null {
  const via = new Map<string, FlowEdge>();
  const queue = [from];
  for (const node of queue) {
    if (node === to) {
      const path: FlowEdge[] = [];
      for (let at = to; at !== from; at = via.get(at)!.from) path.unshift(via.get(at)!);
      return path;
    }
    for (const edge of edges) if (edge.from === node && edge.to !== from && !via.has(edge.to)) {
      via.set(edge.to, edge);
      queue.push(edge.to);
    }
  }
  return null;
}

export function animateFlow(root: SVGGElement, edges: readonly FlowEdge[], centers: ReadonlyMap<string, Point>, toneOf: (node: string) => string, live?: { readonly current: WorkflowPosition | null }): () => void {
  const owner = root.ownerSVGElement;
  const waves = planFlow(edges);
  const start = waves[0]?.[0]?.from;
  if (!owner || !start || typeof IntersectionObserver === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return () => {};
  const center = (node: string) => centers.get(node)!;
  const terminal = (node: string) => !edges.some(edge => edge.from === node);

  const glows = new Map(edges.map(edge => [edge.id, {
    path: svg(root, "path", {
      d: edge.points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(""), class: toneOf(edge.from),
      fill: "none", stroke: "currentColor", "stroke-width": 2.5, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: 0,
    }),
    level: 0, lit: false,
  }]));
  const layer = svg(root, "g", {});
  let orbs: Orb[] = [], sparks: Spark[] = [], ripples: Ripple[] = [];
  let phase: "rest" | "appear" | "travel" | "land" | "live" = live ? "live" : "rest", wave = 0, clock = 0.4 + Math.random() * 1.6, passes = 0;

  const spawn = (node: string, from?: Orb): Orb => {
    const tail = svg(layer, "g", {});
    const body = svg(layer, "g", {});
    svg(body, "circle", { r: 9, fill: "currentColor", opacity: 0.1 });
    svg(body, "circle", { r: 5.5, fill: "currentColor", opacity: 0.2 });
    const shape = svg(body, "ellipse", { rx: RADIUS, ry: RADIUS, fill: "currentColor" });
    svg(body, "circle", { cx: -1, cy: -1.1, r: 1.1, fill: "white", opacity: 0.85 });
    for (let index = 0; index < TAIL; index++) svg(tail, "circle", { r: 0, fill: "currentColor" });
    const p = from ? { ...from.p } : { ...center(node) };
    return { node, angle: from?.angle ?? null, leg: null, s: 0, v: 0, hit: false, dying: false, scale: from?.scale ?? 0,
      target: { ...p }, p, pv: from ? { ...from.pv } : { x: 0, y: 0 }, trail: from ? from.trail.map(point => ({ ...point })) : [], body, shape, tail,
      queue: [], stop: undefined, merging: false, fading: false };
  };
  const tint = (orb: Orb, node: string) => { orb.body.setAttribute("class", toneOf(node)); orb.tail.setAttribute("class", toneOf(node)); };
  const ripple = (at: Point, node: string, from: number, to: number, life: number, delay = 0) =>
    ripples.push({ element: svg(layer, "circle", { cx: at.x, cy: at.y, r: from, fill: "none", stroke: "currentColor", "stroke-width": 1.2, opacity: 0, class: toneOf(node) }), age: -delay, life, from, to });
  const burst = (at: Point, node: string, count: number, heading: number | null) => {
    for (let index = 0; index < count; index++) {
      const angle = heading === null ? Math.random() * Math.PI * 2 : heading + Math.PI + (Math.random() - 0.5) * 2.4;
      const speed = 30 + Math.random() * 45;
      sparks.push({ element: svg(layer, "circle", { r: 0, fill: "currentColor", class: toneOf(node) }), p: { ...at }, v: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed }, age: 0, life: 0.45 + Math.random() * 0.35 });
    }
  };

  const send = (orb: Orb, edge: FlowEdge) => {
    const from = center(edge.from);
    const lead = orb.angle === null ? [from] : arc(from, orb.angle, angleOf(from, edge.points[0]!));
    orb.leg = measure([...lead, ...edge.points, ...(terminal(edge.to) ? [center(edge.to)] : [])], edge, lead.length);
    if (edge.id === orb.stop) orb.leg.hold = HOLD;
    Object.assign(orb, { s: 0, v: 0, hit: false });
    tint(orb, edge.from);
  };
  const startWave = () => {
    const next: Orb[] = [];
    for (const node of new Set(orbs.map(orb => orb.node))) {
      const here = orbs.filter(orb => orb.node === node);
      const out = waves[wave]!.filter(edge => edge.from === node);
      out.forEach((edge, index) => {
        const orb = here[index] ?? spawn(node, here[0]);
        send(orb, edge);
        next.push(orb);
      });
      // Tokens that meet at a join glide together around the halo and merge at the exit.
      for (const orb of here.slice(out.length)) {
        const from = center(node);
        orb.leg = out[0] && orb.angle !== null ? measure(arc(from, orb.angle, angleOf(from, out[0].points[0]!))) : measure([orb.p]);
        Object.assign(orb, { s: 0, v: 0, hit: true, dying: true });
        next.push(orb);
      }
    }
    orbs = next;
  };
  const arrive = (orb: Orb, leg: Leg) => {
    orb.leg = null;
    if (orb.dying) return;
    const edge = leg.edge!;
    orb.node = edge.to;
    orb.angle = terminal(edge.to) ? null : angleOf(center(edge.to), leg.points.at(-1)!);
    glows.get(edge.id)!.lit = true;
  };

  const step = (orb: Orb, h: number) => {
    const leg = orb.leg;
    if (leg) {
      const end = leg.lengths.at(-1)!, total = leg.hold === undefined ? end : leg.edgeStart + leg.edgeLength * leg.hold, gap = total - orb.s;
      const desired = Math.sign(gap) * Math.min(MAX_SPEED, Math.sqrt(2 * BRAKE * Math.abs(gap)));
      orb.v += Math.max(-THRUST, Math.min(THRUST, (desired - orb.v) * RESPONSE)) * h;
      orb.s += orb.v * h;
      orb.target = pointAt(leg, orb.s);
      if (!orb.hit && end - orb.s < 1.5 && leg.edge) {
        orb.hit = true;
        const [a, b] = leg.points.slice(-2);
        if (!terminal(leg.edge.to)) {
          ripple(center(leg.edge.to), leg.edge.to, RING, RING + 8, 0.7);
          burst(orb.target, leg.edge.to, 4, a && b ? angleOf(a, b) : null);
        }
      }
      if (leg.hold === undefined && Math.abs(total - orb.s) < 0.5 && Math.abs(orb.v) < 8) arrive(orb, leg);
    }
    orb.pv.x += (SPRING * (orb.target.x - orb.p.x) - DAMPING * orb.pv.x) * h;
    orb.pv.y += (SPRING * (orb.target.y - orb.p.y) - DAMPING * orb.pv.y) * h;
    orb.p.x += orb.pv.x * h;
    orb.p.y += orb.pv.y * h;
  };

  const finale = (end: string) => {
    ripple(center(end), end, 6, RING + 10, 0.9);
    ripple(center(end), end, 6, RING + 4, 0.9, 0.18);
    burst(center(end), end, 8, null);
    for (const glow of glows.values()) glow.level = Math.max(glow.level, 0.45);
  };

  // Live mode: one token per observed station. A token reaches its station along the diagram's routes,
  // forks for parallel stations, and merges into a remaining token when its station is no longer active.
  const via = (orb: Orb) => orb.leg?.edge?.to ?? orb.node;
  const goal = (target: string) => edges.find(edge => edge.id === target);
  const plan = (orb: Orb, target: string): FlowEdge[] | null => {
    const hold = goal(target);
    if (hold && orb.leg?.edge === hold && orb.leg.hold !== undefined) return [];
    const path = route(edges, via(orb), hold ? hold.from : target);
    return path && (hold ? [...path, hold] : path);
  };
  const assign = (orb: Orb, target: string, path: FlowEdge[]) => {
    orb.queue = path;
    orb.stop = goal(target)?.id;
    if (orb.leg?.hold !== undefined && orb.leg.edge?.id !== target) delete orb.leg.hold;
  };
  let seen = "", pulse = 0;
  const retarget = (position: WorkflowPosition) => {
    const free = orbs.filter(orb => !orb.fading && !orb.merging);
    const kept: Orb[] = [];
    for (const target of position.targets) {
      let best: { orb: Orb; path: FlowEdge[] } | undefined;
      for (const orb of free) {
        const path = plan(orb, target);
        if (path && (!best || path.length < best.path.length)) best = { orb, path };
      }
      if (best) free.splice(free.indexOf(best.orb), 1);
      else {
        const parent = kept.find(orb => plan(orb, target));
        let orb = parent ? spawn(via(parent), parent) : spawn(start);
        if (!parent) tint(orb, start);
        let path = plan(orb, target);
        if (!path) {
          orb.body.remove(); orb.tail.remove();
          orb = spawn(goal(target)?.from ?? target);
          path = plan(orb, target) ?? [];
        }
        orbs.push(orb);
        best = { orb, path };
      }
      assign(best.orb, target, best.path);
      kept.push(best.orb);
    }
    for (const orb of free) {
      const join = position.targets.map(target => plan(orb, target)).find(Boolean);
      if (join) { orb.queue = join; orb.stop = undefined; orb.merging = true; }
      else orb.fading = true;
    }
  };
  const follow = (dt: number, position: WorkflowPosition) => {
    const key = `${position.targets.join()}:${position.state}`;
    if (key !== seen) { seen = key; retarget(position); pulse = 0.6; }
    pulse -= dt;
    const beat = pulse <= 0 && position.state !== "idle" && position.state !== "done";
    if (beat) pulse = position.state === "working" ? 2.4 : 3.6;
    for (const orb of orbs) {
      if (orb.fading) { orb.scale = Math.max(0, orb.scale - dt * 3); continue; }
      orb.scale += ((position.state === "idle" ? 0.7 : 1) - orb.scale) * (1 - Math.exp(-dt * 6));
      if (orb.leg) {
        if (beat && orb.leg.hold !== undefined) ripple(orb.target, orb.leg.edge!.from, 4, 16, 1.2);
        continue;
      }
      const next = orb.queue.shift();
      if (next) { send(orb, next); continue; }
      if (orb.merging) { orb.fading = true; continue; }
      if (position.state === "done" && terminal(orb.node)) { finale(orb.node); orb.fading = true; continue; }
      const at = center(orb.node);
      if (orb.angle === null) orb.angle = -Math.PI / 2;
      if (position.state === "working") orb.angle += ORBIT * dt;
      orb.target = { x: at.x + RING * Math.cos(orb.angle), y: at.y + RING * Math.sin(orb.angle) };
      tint(orb, orb.node);
      if (beat) ripple(at, orb.node, RING, RING + (position.state === "working" ? 8 : 5), position.state === "working" ? 1 : 1.6);
    }
  };

  const update = (dt: number) => {
    const settle = 1 - Math.exp(-dt * 2.2);
    clock -= dt;
    if (live?.current) follow(dt, live.current);
    else if (phase === "rest" && clock <= 0) {
      const orb = spawn(start);
      tint(orb, start);
      orbs = [orb];
      phase = "appear";
      clock = 0.35;
    } else if (phase === "appear") {
      for (const orb of orbs) orb.scale = 1 - Math.max(0, clock) / 0.35;
      if (clock <= 0) { phase = "travel"; wave = 0; startWave(); }
    } else if (phase === "travel") {
      if (orbs.some(orb => orb.leg)) clock = DWELL;
      else if (clock <= 0 && ++wave < waves.length) startWave();
      else if (clock <= 0) {
        phase = "land";
        clock = 0.5;
        finale(orbs[0]?.node ?? start);
      }
    } else if (phase === "land") {
      for (const orb of orbs) orb.scale = Math.max(0, clock) / 0.5;
      if (clock <= 0) {
        for (const orb of orbs) { orb.body.remove(); orb.tail.remove(); }
        orbs = [];
        phase = "rest";
        clock = ++passes < PASSES ? REST : Infinity;
      }
    }
    const substeps = Math.ceil(dt * 240);
    for (let index = 0; index < substeps; index++) for (const orb of orbs) step(orb, dt / substeps);
    orbs = orbs.filter(orb => {
      if (orb.fading ? orb.scale > 0 : !orb.dying || orb.leg) return true;
      orb.body.remove();
      orb.tail.remove();
      return false;
    });

    for (const orb of orbs) {
      orb.trail.unshift({ ...orb.p });
      orb.trail.length = Math.min(orb.trail.length, TAIL);
      const speed = Math.hypot(orb.pv.x, orb.pv.y);
      const stretch = Math.min(speed / 320, 0.7);
      orb.body.setAttribute("transform", `translate(${orb.p.x} ${orb.p.y}) scale(${orb.scale})`);
      orb.body.setAttribute("opacity", String(Math.min(1, orb.scale) ** 2));
      orb.shape.setAttribute("rx", String(RADIUS * (1 + stretch)));
      orb.shape.setAttribute("ry", String(RADIUS / (1 + stretch * 0.5)));
      orb.shape.setAttribute("transform", `rotate(${Math.atan2(orb.pv.y, orb.pv.x) * 180 / Math.PI})`);
      Array.from(orb.tail.children).forEach((dot, index) => {
        const point = orb.trail[index] ?? orb.p, fade = 1 - index / TAIL;
        dot.setAttribute("cx", String(point.x));
        dot.setAttribute("cy", String(point.y));
        dot.setAttribute("r", String(RADIUS * 0.9 * fade * orb.scale));
        dot.setAttribute("opacity", String(0.3 * fade * Math.min(1, speed / 60)));
      });
    }
    for (const [id, glow] of glows) {
      const active = orbs.find(orb => orb.leg?.edge?.id === id);
      if (active) {
        const leg = active.leg!;
        glow.level = 0.55;
        glow.path.setAttribute("stroke-dasharray", `${Math.max(0, Math.min(leg.edgeLength, active.s - leg.edgeStart))} ${leg.edgeLength + 1}`);
      } else {
        glow.path.removeAttribute("stroke-dasharray");
        glow.level += ((phase === "rest" || !glow.lit ? 0 : 0.14) - glow.level) * settle;
        if (phase === "rest") glow.lit = false;
      }
      glow.path.setAttribute("opacity", String(glow.level));
    }
    sparks = sparks.filter(spark => {
      spark.age += dt;
      const drag = Math.exp(-3 * dt);
      spark.v.x *= drag;
      spark.v.y = spark.v.y * drag + 70 * dt;
      spark.p.x += spark.v.x * dt;
      spark.p.y += spark.v.y * dt;
      const left = 1 - spark.age / spark.life;
      if (left <= 0) { spark.element.remove(); return false; }
      spark.element.setAttribute("cx", String(spark.p.x));
      spark.element.setAttribute("cy", String(spark.p.y));
      spark.element.setAttribute("r", String(1.1 * left));
      spark.element.setAttribute("opacity", String(0.7 * left));
      return true;
    });
    ripples = ripples.filter(ring => {
      ring.age += dt;
      const t = Math.max(0, ring.age) / ring.life;
      if (t >= 1) { ring.element.remove(); return false; }
      ring.element.setAttribute("r", String(ring.from + (ring.to - ring.from) * (1 - (1 - t) ** 3)));
      ring.element.setAttribute("opacity", String(ring.age < 0 ? 0 : 0.4 * (1 - t)));
      return true;
    });
  };

  // True when another frame would draw the same picture: nothing travels, orbits, fades, or settles.
  const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.1 && Math.abs(a.y - b.y) < 0.1;
  const still = () => {
    const position = live?.current;
    if (position ? position.state === "working" : phase !== "rest") return false;
    const scale = position?.state === "idle" ? 0.7 : 1;
    return !sparks.length && !ripples.length
      && orbs.every(orb => !orb.leg && !orb.queue.length && !orb.fading && !orb.merging && !orb.dying
        && Math.abs(orb.scale - scale) < 0.002 && Math.abs(orb.pv.x) + Math.abs(orb.pv.y) < 0.5
        && near(orb.p, orb.target) && orb.trail.every(point => near(point, orb.p)))
      && [...glows.values()].every(glow => Math.abs(glow.level - (phase === "rest" || !glow.lit ? 0 : 0.14)) < 0.002);
  };

  // Each frame writes SVG attributes, which lays the drawing out again, so a still picture schedules no frames.
  // It wakes when the demo's rest ends, or every 250 ms in live mode to pick up a new position or heartbeat.
  // After its last pass the demo never wakes.
  let frame = 0, last = 0, sleep: ReturnType<typeof setTimeout> | undefined;
  const run = (now: number) => {
    if (still()) {
      if (!live && clock === Infinity) return;
      const began = now;
      sleep = setTimeout(() => {
        sleep = undefined;
        update(Math.min(5, (performance.now() - began) / 1000));
        frame = requestAnimationFrame(tick);
      }, live ? 250 : Math.max(16, clock * 1000));
    } else frame = requestAnimationFrame(tick);
  };
  const tick = (now: number) => {
    // 30 fps cap: each update dirties the SVG and costs a full-page rendering update.
    if (last && now - last < 30) {
      frame = requestAnimationFrame(tick);
      return;
    }
    update(last ? Math.min(0.05, (now - last) / 1000) : 0);
    last = now;
    run(now);
  };
  const stop = () => { cancelAnimationFrame(frame); clearTimeout(sleep); sleep = undefined; last = 0; };
  // Runs only while the illustration is on screen; the hidden wide or compact copy stays idle.
  const observer = new IntersectionObserver(([entry]) => {
    stop();
    if (entry?.isIntersecting) frame = requestAnimationFrame(tick);
  });
  observer.observe(owner);
  return () => {
    observer.disconnect();
    stop();
    root.replaceChildren();
  };
}
