// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { WorkflowIllustration } from "../src/frontend/features/tasks/workflow-illustration.js";
import { WORKFLOWS } from "../src/frontend/features/tasks/workflow-presentation.js";
import { flowEdges, planFlow } from "../src/frontend/features/tasks/workflow-flow.js";
import layouts from "../src/frontend/features/tasks/workflow-layouts.json" with { type: "json" };

test.each(WORKFLOWS)("$name describes the actual workflow and delivery in both layouts", definition => {
  if (definition.id !== "refine_pull_request") {
    const main = definition.id === "competing_plans" ? ["objective", "combine", "build", "review", "delivery"]
      : definition.id === "independent_review" ? ["plan", "build", "review", "reviewer", "delivery"]
      : ["plan", "build", "review", "delivery"];
    for (const [mode, axis, crossAxis] of [["wide", "x", "y"], ["compact", "y", "x"]] as const) {
      const nodes = main.map(id => layouts[definition.id][mode].nodes.find(node => node.id === id)!);
      expect(nodes.every((node, index) => !index || node[axis] > nodes[index - 1]![axis])).toBe(true);
      expect(Math.max(...nodes.map(node => node[crossAxis])) - Math.min(...nodes.map(node => node[crossAxis]))).toBeLessThan(20);
    }
  }
  if (definition.id === "competing_plans") {
    for (const edge of layouts.competing_plans.wide.edges.filter(edge => /^(objective-plan-[ab]|plan-[ab]-combine)$/.test(edge.id))) {
      const points = edge.points;
      expect(points[1]!.x).toBeCloseTo((points[0]!.x + points[3]!.x) / 2);
      expect(points[2]!.x).toBeCloseTo(points[1]!.x);
    }
  }
  if (definition.id === "refine_pull_request") {
    const nodes = layouts.refine_pull_request.wide.nodes;
    const merge = nodes.find(node => node.id === "merge")!;
    expect(merge.x).toBeGreaterThan(Math.max(...nodes.filter(node => node.id !== "merge").map(node => node.x)));
    expect(merge.y).toBe(nodes.find(node => node.id === "coordinator")!.y);
    const mergeRoute = layouts.refine_pull_request.wide.edges.find(edge => edge.id === "coordinator-merge")!.points;
    expect(mergeRoute).toHaveLength(2);
    expect(mergeRoute[0]!.y).toBe(mergeRoute[1]!.y);
  }
  const element = document.createElement("div");
  element.innerHTML = renderToStaticMarkup(<WorkflowIllustration workflow={definition.id} delivery="Push branch" />);
  const diagrams = element.querySelectorAll('[data-illustration-layout][role="img"]');
  expect(diagrams).toHaveLength(2);
  for (const diagram of Array.from(diagrams)) {
    expect(diagram.querySelector("title")?.textContent).toBe(`${definition.name} workflow`);
    expect(diagram.querySelector("desc")?.textContent).toContain(definition.steps.join(" "));
    expect(diagram.querySelector("desc")?.textContent).toContain("Push branch");
    expect(diagram.textContent).toContain(definition.id === "refine_pull_request" ? "merges the PR" : "pushes the branch");
    const reviewReturn = diagram.querySelector('[data-illustration-route="review-build"]');
    if (definition.id === "refine_pull_request") expect(reviewReturn).toBeNull();
    else {
      expect(reviewReturn?.getAttribute("stroke-dasharray")).toBe("3 5");
      expect(diagram.querySelector("desc")?.textContent).toContain("Coordinator can send changes back to Worker after review.");
    }
    for (const route of Array.from(diagram.querySelectorAll("[data-illustration-route]"))) {
      const markerId = route.getAttribute("marker-end")?.match(/^url\(#(.+)\)$/)?.[1];
      expect(markerId).toBeTruthy();
      expect(Array.from(diagram.querySelectorAll("marker")).some(marker => marker.id === markerId)).toBe(true);
    }
    if (definition.id === "competing_plans") {
      for (const path of ["objective-plan-a", "objective-plan-b", "plan-a-combine", "plan-b-combine", "build-review", "review-delivery"]) expect(diagram.querySelector(`[data-illustration-route="${path}"]`)).not.toBeNull();
      expect(diagram.querySelector('[data-illustration-control="objective"]')?.textContent).toBe("Userprompts");
    }
    if (definition.id === "independent_review") {
      expect(diagram.querySelector('[data-illustration-route="reviewer-build"]')).not.toBeNull();
      expect(diagram.querySelector('[data-illustration-route="reviewer-delivery"]')).not.toBeNull();
      expect(diagram.querySelector('[data-illustration-route="build-delivery"]')).toBeNull();
    }
    if (definition.id === "refine_pull_request") {
      for (const path of ["rater-coordinator", "coordinator-repair", "repair-rater", "coordinator-merge"]) expect(diagram.querySelector(`[data-illustration-route="${path}"]`)).not.toBeNull();
      expect(diagram.querySelector('[data-illustration-route="repair-rater"]')?.getAttribute("stroke-dasharray")).toBe("3 5");
      expect(diagram.querySelector('[data-illustration-route="merge-rater"]')).toBeNull();
      expect(diagram.querySelector('[data-illustration-station="checks"]')).toBeNull();
      expect(diagram.textContent).toContain("9/10 or more");
      expect(diagram.textContent).toContain("directs the next step");
      expect(diagram.querySelector("desc")?.textContent).toContain("Coordinator directs repair or delivery");
      expect(diagram.querySelector('[data-illustration-control="merge"] > div')?.children).toHaveLength(2);
    }
  }
  element.innerHTML = renderToStaticMarkup(<WorkflowIllustration workflow={definition.id} delivery="Push branch" agents={{
    root: <button>root</button>, worker: <button>worker</button>, reviewer: <button>reviewer</button>,
    planner_a: <button>planner_a</button>, planner_b: <button>planner_b</button>, rater: <button>rater</button>,
  }} />);
  const interactiveDiagrams = element.querySelectorAll('[data-illustration-layout][role="group"]');
  expect(interactiveDiagrams).toHaveLength(2);
  for (const diagram of Array.from(interactiveDiagrams)) {
    expect(new Set(Array.from(diagram.querySelectorAll("button"), button => button.textContent))).toEqual(new Set(["root", "worker", ...definition.advisorRoles]));
    expect(diagram.getAttribute("aria-labelledby")).toBe(diagram.querySelector("title")?.id);
  }
});

test("pull request repair names the selected pull request in both layouts", () => {
  const html = renderToStaticMarkup(<WorkflowIllustration workflow="refine_pull_request" delivery="Merged pull request" pullRequestNumber={285} />);
  const element = document.createElement("div");
  element.innerHTML = html;
  for (const source of Array.from(element.querySelectorAll('[data-illustration-station="source"]'))) expect(source.textContent).toContain("PR #285");
});

test("read-only agent names replace role labels only when their profiles resolve", () => {
  const element = document.createElement("div");
  element.innerHTML = renderToStaticMarkup(<WorkflowIllustration workflow="independent_review" delivery="Push branch" agentNames={{ root: "Ada", worker: "Bea" }} />);
  for (const diagram of Array.from(element.querySelectorAll('[data-illustration-layout][role="group"]'))) {
    expect(diagram.querySelector('[data-illustration-control="plan"]')?.textContent).toContain("Ada");
    expect(diagram.querySelector('[data-illustration-control="build"]')?.textContent).toContain("Bea");
    expect(diagram.querySelector('[data-illustration-control="reviewer"]')).toBeNull();
    expect(diagram.querySelectorAll("button")).toHaveLength(0);
  }
});

test.each(WORKFLOWS)("$name flow travels every route and ends at the terminal station", definition => {
  for (const layout of Object.values(layouts[definition.id])) {
    const edges = flowEdges(layout, new Set(["review-build", "reviewer-build", "repair-rater"]));
    const waves = planFlow(edges);
    expect(new Set(waves.flat())).toEqual(new Set(edges));
    for (const [index, wave] of waves.entries()) if (index) expect(wave.every(edge => waves[index - 1]!.some(previous => previous.to === edge.from))).toBe(true);
    const end = waves.at(-1)!;
    expect(end).toHaveLength(1);
    expect(edges.some(edge => edge.from === end[0]!.to)).toBe(false);
  }
  if (definition.id === "competing_plans") expect(planFlow(flowEdges(layouts.competing_plans.wide, new Set())).map(wave => wave.map(edge => edge.id))).toEqual([
    ["objective-plan-a", "objective-plan-b"], ["plan-a-combine", "plan-b-combine"], ["combine-build"], ["build-review"], ["review-build"], ["build-review"], ["review-delivery"],
  ]);
});
