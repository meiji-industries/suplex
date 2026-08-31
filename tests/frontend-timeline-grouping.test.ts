import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { summarizeAgentTime, TimelineTotals, type TimelineTask } from "../src/frontend/views/timeline.js";

const tasks: TimelineTask[] = [
  { id: "ticket-a", projectId: "project-a", issueKey: "FORGE-1", title: "Forge ticket", agentInvocations: [{ id: "builder-a", role: "builder", status: "completed", attempt: 1, startedAt: "2026-08-10T09:00:00.000Z", finishedAt: "2026-08-10T11:00:00.000Z", agentId: "builder", agentName: "Builder", avatarSeed: "a".repeat(32) }] },
  { id: "ticket-b", projectId: "project-b", issueKey: "HERDR-1", title: "Herdr ticket", agentInvocations: [{ id: "planner-b", role: "planner", status: "completed", attempt: 1, startedAt: "2026-08-10T10:00:00.000Z", finishedAt: "2026-08-10T11:00:00.000Z", agentId: "planner", agentName: "Planner", avatarSeed: "b".repeat(32) }] },
];
const summary = summarizeAgentTime(tasks, [{ id: "project-a", name: "Forge" }, { id: "project-b", name: "Herdr" }], { start: Date.parse("2026-08-10T00:00:00.000Z"), end: Date.parse("2026-08-11T00:00:00.000Z") }, Date.parse("2026-08-11T00:00:00.000Z"));

test("renders flat and grouped timeline totals", () => {
  const flat = renderToStaticMarkup(createElement(TimelineTotals, { summary, groupByProject: false, companyId: "company" }));
  expect(flat.match(/aria-label="Daily agent-hours"/g)).toHaveLength(1);
  expect(flat).not.toContain("data-project-header");

  const grouped = renderToStaticMarkup(createElement(TimelineTotals, { summary, groupByProject: true, companyId: "company" }));
  expect(grouped).toContain('aria-expanded="false"');
  expect(grouped).not.toContain('aria-label="Daily agent-hours"');
  expect(grouped.indexOf('data-project-header="Forge"')).toBeLessThan(grouped.indexOf('data-project-header="Herdr"'));
});

test("shows project names while grouped timeline totals are closed", () => {
  const grouped = renderToStaticMarkup(createElement(TimelineTotals, { summary, groupByProject: true, companyId: "company" }));
  expect(grouped).toContain("Forge");
  expect(grouped).toContain("Herdr");
});
