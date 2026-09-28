import { expect, test } from "vitest";
import { workflowTopology } from "../src/frontend/features/tasks/workflow-plan-model.js";

const edge = (workflow: Parameters<typeof workflowTopology>[0], from: string, to: string) => workflowTopology(workflow, "Delivery target").edges.find(item => item.from === from && item.to === to);

test("combined planning explicitly forks and joins both planner lanes", () => {
  const topology = workflowTopology("competing_plans", "Delivery target");
  expect(topology.edges.map(({ from, to }) => [from, to])).toEqual([
    ["objective", "plan-a"], ["objective", "plan-b"], ["plan-a", "combine"], ["plan-b", "combine"], ["combine", "build"], ["build", "review"], ["review", "target"],
  ]);
});

test("direct build gives Worker the same action label as the New Task preview", () => {
  expect(workflowTopology("direct_build", "Delivery target").nodes.find(node => node.id === "build")?.label).toBe("Worker does the work");
});

test("second opinion approves directly and sends blocking work through a fresh review", () => {
  expect(edge("independent_review", "reviewer", "target")?.condition).toBe("Approve");
  expect(edge("independent_review", "reviewer", "repair")?.condition).toBe("Blocking findings");
  expect(edge("independent_review", "repair", "inspection")).toBeDefined();
  expect(edge("independent_review", "inspection", "reviewer")?.condition).toBe("Fresh review");
  expect(edge("independent_review", "repair", "target")).toBeUndefined();
});

test("pull request repair bypasses repair only after a qualifying rating and returns failures to Rater", () => {
  expect(edge("refine_pull_request", "rater", "push")?.condition).toContain("9/10+");
  expect(edge("refine_pull_request", "rater", "repair")?.condition).toBe("Otherwise");
  expect(edge("refine_pull_request", "repair", "rater")?.condition).toBe("Fresh rating");
  expect(edge("refine_pull_request", "push", "rater")?.condition).toBe("CI fails");
  expect(edge("refine_pull_request", "repair", "push")).toBeUndefined();
});

test("pull request repair names the task pull request when available", () => {
  expect(workflowTopology("refine_pull_request", "Delivery target", 285).nodes[0]?.label).toBe("PR #285");
  expect(workflowTopology("refine_pull_request", "Delivery target").nodes[0]?.label).toBe("Existing pull request");
});

test("every graph has compact in-bounds stations and paths that meet station boundaries", () => {
  for (const workflow of ["standard", "direct_build", "independent_review", "competing_plans", "refine_pull_request"] as const) {
    const topology = workflowTopology(workflow, "Delivery target");
    expect(topology.height - Math.max(...topology.nodes.map(station => station.y + (station.height ?? 48)))).toBeLessThanOrEqual(12);
    for (const station of topology.nodes) {
      expect(station.x).toBeGreaterThanOrEqual(0);
      expect(station.x + (station.width ?? 190)).toBeLessThanOrEqual(390);
      expect(station.y + (station.height ?? 48)).toBeLessThanOrEqual(topology.height);
    }
  }
  expect(edge("independent_review", "inspection", "reviewer")?.path).toBe("M12 364H4V224H100");
  expect(edge("refine_pull_request", "repair", "rater")?.path).toBe("M12 232H4V96H100");
  expect(edge("refine_pull_request", "push", "rater")?.path).toBe("M378 232V248H386V96H290");
});
