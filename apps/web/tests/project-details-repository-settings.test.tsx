// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

import type { ApiProject } from "../shell/view-shared.js";
import { ProjectDetails } from "../features/projects/project-details.js";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn() }));
vi.mock("../lib/api.js", async importOriginal => ({ ...(await importOriginal()), ...api }));
const company = vi.hoisted(() => ({ currentCompany: { id: "company-1" }, loading: false, reloadCompanies: vi.fn() }));
vi.mock("../shell/company-context.js", () => ({ useCompanyContext: () => company }));
vi.mock("../features/projects/project-details-layout.js", () => ({ ProjectDetailsLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));

const project: ApiProject = {
  id: "project-1", companyId: "company-1", name: "Repository", repository: "owner/repo", repositoryPath: "/repo", worktreeRoot: "/worktrees", baseBranch: "main", setupCommand: "install", verificationCommand: "check", rootProfileId: "root", workerProfileId: "worker", altProfileId: "root",
  agentTaskPolicy: { workflowIds: ["standard"], defaultWorkflowId: "standard", templateIds: [], rootProfileIds: ["root"], workerProfileIds: ["worker"], advisorProfileIds: { reviewer: [], planner_a: [], planner_b: [], rater: [] }, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" },
  providerPolicy: null, taskConcurrency: 1, repositorySettings: null, createdAt: "", updatedAt: "",
};

test("Execution disables repository fields, describes their source, and displays file errors", async () => {
  window.location.hash = "execution";
  for (const settings of [
    { path: ".suplex/settings.toml", fields: ["setup_command", "verification_command", "task_concurrency", "instructions"], error: null },
    { path: ".suplex/settings.toml", fields: [], error: "Task concurrency must be a whole number of 1 or more." },
    null,
  ] satisfies ApiProject["repositorySettings"][]) {
    api.readJsonUnchecked.mockImplementation(async (url: string) => url === "/api/profiles" ? { profiles: [] } : url.endsWith("/provider-instances") ? { instances: [] } : { ...project, repositorySettings: settings });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ProjectDetails projectId={project.id} />));
      for (const id of ["project-setup-command", "project-verification-command", "project-task-concurrency", "project-instructions"]) {
        const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
        expect(input).not.toBeNull();
        expect(input?.disabled).toBe(settings?.fields.length === 4);
      }
      expect(container.querySelector<HTMLTextAreaElement>("#project-skills")?.disabled).toBe(false);
      expect(container.textContent?.split("Provided by .suplex/settings.toml in the repository.").length).toBe(settings?.fields.length === 4 ? 5 : 1);
      expect(container.querySelector('[role="alert"]')?.textContent ?? null).toBe(settings?.error ?? null);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }
  window.location.hash = "";
});
