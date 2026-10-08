// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { animateFlow, flowEdges } from "../features/tasks/workflow-flow.js";
import type { WorkflowPosition } from "../features/tasks/workflow-position.js";
import layouts from "../features/tasks/workflow-layouts.json" with { type: "json" };

// Each animation frame rewrites SVG attributes and lays the drawing out again, so a still picture must not ask for frames.
let frames = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  const request = window.requestAnimationFrame;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames++; return request(callback); });
  vi.stubGlobal("IntersectionObserver", class { constructor(private readonly callback: IntersectionObserverCallback) {} observe() { this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never); } disconnect() {} });
  frames = 0;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function animate(live?: { current: WorkflowPosition }) {
  const layout = layouts.standard.wide;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const root = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.append(root);
  document.body.append(svg);
  const centers = new Map(layout.nodes.map(node => [node.id, { x: node.x + 22, y: node.y + 22 }]));
  return animateFlow(root, flowEdges(layout, new Set(["review-build"])), centers, () => "", live);
}
const framesDuring = (ms: number) => { const before = frames; vi.advanceTimersByTime(ms); return frames - before; };

test("the demo plays, then stops asking for frames", () => {
  const stop = animate();
  expect(framesDuring(10_000)).toBeGreaterThan(300);
  vi.advanceTimersByTime(60_000);
  expect(framesDuring(10_000)).toBe(0);
  stop();
});

test("a live position that is not working wakes only to check for changes", () => {
  const live = { current: { targets: ["build"], state: "idle" } as WorkflowPosition };
  const stop = animate(live);
  vi.advanceTimersByTime(10_000);
  expect(framesDuring(10_000)).toBeLessThanOrEqual(40);
  live.current = { targets: ["build"], state: "working" };
  vi.advanceTimersByTime(1_000);
  expect(framesDuring(10_000), "a working agent keeps orbiting").toBeGreaterThan(300);
  stop();
});
