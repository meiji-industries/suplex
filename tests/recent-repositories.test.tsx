// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const projectApi = vi.hoisted(() => ({ createProject: vi.fn(), listRecentRepositories: vi.fn() }));
vi.mock("../src/frontend/features/projects/lib/project-api.js", () => projectApi);

import { RecentRepositories } from "../src/frontend/features/projects/recent-repositories.js";
import { ApiError } from "../src/frontend/lib/api.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

test("a recent repository disappears after creation even when the parent refresh fails", async () => {
  projectApi.listRecentRepositories.mockResolvedValue([{ repository: "octocat/Hello-World", defaultBranch: "master", pushedAt: new Date().toISOString() }]);
  projectApi.createProject.mockResolvedValue({ id: "project-1" });
  const onAdded = vi.fn();
  const onCreated = vi.fn().mockRejectedValue(new Error("refresh failed"));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RecentRepositories companyId="company-1" projects={[]} canSignInToGitHub onAdded={onAdded} onCreated={onCreated} />));
  await act(async () => { await Promise.resolve(); });
  const add = container.querySelector<HTMLButtonElement>('[aria-label="Add octocat/Hello-World"]')!;
  await act(async () => add.click());
  expect(projectApi.createProject).toHaveBeenCalledTimes(1);
  expect(onAdded).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain("octocat/Hello-World");
  expect(container.textContent).toContain("The project was added. Suplex could not refresh projects. Select Check again.");
  await act(async () => root.unmount());
});

test("an auth failure keeps the suggestion and offers GitHub sign-in", async () => {
  projectApi.listRecentRepositories.mockResolvedValue([{ repository: "octocat/Hello-World", defaultBranch: "master", pushedAt: new Date().toISOString() }]);
  projectApi.createProject.mockRejectedValue(new ApiError("Project configuration is invalid", 422, [{ code: "github-auth-unavailable", field: "repository", message: "GitHub is not signed in." }]));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RecentRepositories companyId="company-1" projects={[]} canSignInToGitHub onCreated={vi.fn()} />));
  await act(async () => { await Promise.resolve(); });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add octocat/Hello-World"]')!.click());
  expect(container.textContent).toContain("octocat/Hello-World");
  expect(container.textContent).toContain("GitHub is not signed in.");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent === "Sign in to GitHub")).toBe(true);
  await act(async () => root.unmount());
});
