import { expect, test, vi } from "vitest";
import { nativeApp } from "./helpers/native-app.js";
import { ProjectBodySchema } from "../src/http/contracts/projects.js";

test("projects expose two profile defaults and no check or activation mirror", async () => {
  const f = await nativeApp();
  try {
    const result = await f.app.inject({ method: "GET", url: `/api/projects/${f.project.id}`, headers: f.headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker", baseBranch: "main" });
    for (const field of ["roleDefaults", "requiredChecks", "targetBranch", "status"]) expect(result.json()).not.toHaveProperty(field);
    const { id } = f.project;
    const input = ProjectBodySchema.strip().parse(f.project);
    const saved = await f.app.inject({ method: "PATCH", url: `/api/projects/${id}`, headers: f.headers, payload: { ...input, name: "Renamed" } });
    expect(saved.statusCode, saved.body).toBe(200);
    const invalid = await f.app.inject({ method: "PATCH", url: `/api/projects/${id}`, headers: f.headers, payload: { ...input, rootProfileId: input.workerProfileId } });
    expect(invalid.statusCode).toBe(422);
    expect(f.projects.getProject(f.userId, id).name).toBe("Renamed");
    expect((await f.app.inject({ method: "GET", url: "/api/admin/capacity", headers: f.headers })).statusCode).toBe(404);
  } finally { await f.close(); }
});

test("project task sources accept issue discovery through the HTTP route", async () => {
  const f = await nativeApp();
  try {
    const issue = { kind: "issue" as const, number: 42, url: "https://github.com/owner/repo/issues/42", title: "Fix search", body: "Details", author: "octo", updatedAt: "2026-09-07T23:00:00Z" };
    const discover = vi.spyOn(f.projects, "discoverTaskSources").mockResolvedValue({ available: true, sources: [issue] });

    const response = await f.app.inject({ method: "GET", url: `/api/projects/${f.project.id}/task-sources?kind=issue`, headers: f.headers });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ available: true, sources: [issue] });
    expect(discover).toHaveBeenCalledWith(f.userId, f.project.id, "issue");
  } finally { await f.close(); }
});
