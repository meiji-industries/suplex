import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { ProviderContextBar, SetupFooter, setupChecklist, setupContext } from "../src/frontend/features/settings/setup.js";
import type { HealthCheck, HealthSnapshot } from "../src/platform/health.js";
import type { ProfileResponse, ProjectResponse } from "../src/http/contracts/projects.js";

const check = (id: HealthCheck["id"], provider?: HealthCheck["provider"]): HealthCheck => ({ id, label: id, status: "unhealthy", summary: "Not available", details: {}, ...(provider ? { provider } : {}) });

const snapshot = (checks: HealthCheck[]): HealthSnapshot => ({ generatedAt: "2026-09-08T00:00:00.000Z", reachableAddress: "http://127.0.0.1:4111", ready: true, checks });

const profile = (id: string, name = id): ProfileResponse => ({ id, name }) as ProfileResponse;
const project = { id: "project-1", name: "Site" } as ProjectResponse;

test("the setup checklist is Git, Herdr, and the context providers only", () => {
  const list = setupChecklist(snapshot([
    check("database"), check("git"), check("herdr-readiness"), check("gh-auth"),
    check("provider:opencode", "opencode"), check("provider:claude-code", "claude-code"), check("provider:codex", "codex"),
  ]));
  expect(list.map(({ id }) => id)).toEqual(["git", "herdr-readiness", "provider:opencode", "provider:claude-code", "provider:codex"]);
  // With no provider context the checklist is only the host tools.
  expect(setupChecklist(snapshot([check("git"), check("herdr-readiness")])).map(({ id }) => id)).toEqual(["git", "herdr-readiness"]);
  expect(setupChecklist(undefined)).toEqual([]);
});

test("the setup context selects the project, else the active profile, else nothing", () => {
  expect(setupContext("project-1", project, "profile-1")).toEqual({ projectId: "project-1" });
  expect(setupContext("project-1", undefined, "profile-1")).toBeUndefined(); // Project still loading.
  expect(setupContext("project-1", null, "profile-1")).toEqual({ profileIds: ["profile-1"] });
  expect(setupContext(undefined, undefined, "profile-1")).toEqual({ profileIds: ["profile-1"] });
  expect(setupContext(undefined, undefined, undefined)).toBeUndefined();
});

test("with no profiles, setup offers profile settings and claims no provider readiness", () => {
  const html = renderToStaticMarkup(createElement(ProviderContextBar, {
    projectId: undefined, project: undefined, profiles: [], activeProfileId: undefined, onSelectProfile: () => {},
  }));
  expect(html).toContain("No profiles. Forge checks Git and Herdr.");
  expect(html).toContain('href="/admin/profiles"');
  expect(html).toContain("Open profile settings");
  expect(html).not.toMatch(/OpenCode|Claude Code/);
});

test("a project context names the project instead of offering a profile picker", () => {
  const loading = renderToStaticMarkup(createElement(ProviderContextBar, {
    projectId: "project-1", project: undefined, profiles: [profile("p1")], activeProfileId: "p1", onSelectProfile: () => {},
  }));
  expect(loading).toContain("Forge reads the project.");
  const loaded = renderToStaticMarkup(createElement(ProviderContextBar, {
    projectId: "project-1", project, profiles: [profile("p1")], activeProfileId: "p1", onSelectProfile: () => {},
  }));
  expect(loaded).toContain("Project Site");
  expect(loaded).not.toContain("Select a profile");
});

test("Continue is always enabled and links to the task list", () => {
  for (const [status, refreshing] of [["All checks are healthy.", false], ["Forge could not check the host. Select Check again.", false], ["2 checks need attention.", false], ["Forge checks the host.", true]] as const) {
    const html = renderToStaticMarkup(createElement(SetupFooter, { status, refreshing, onCheckAgain: () => {} }));
    expect(html).toContain('href="/tasks"');
    expect(html).toContain("Continue");
    const anchor = /<a [^>]*href="\/tasks"[^>]*>/.exec(html)?.[0] ?? "";
    expect(anchor).not.toMatch(/\sdisabled[=>]|aria-disabled/);
  }
});
