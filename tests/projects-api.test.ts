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
    const partial = await f.app.inject({ method: "PATCH", url: `/api/projects/${id}`, headers: f.headers, payload: { name: "Renamed again" } });
    expect(partial.statusCode, partial.body).toBe(200);
    expect(partial.json()).toMatchObject({ name: "Renamed again", repositoryPath: input.repositoryPath, baseBranch: input.baseBranch });
    const invalid = await f.app.inject({ method: "PATCH", url: `/api/projects/${id}`, headers: f.headers, payload: { ...input, rootProfileId: input.workerProfileId } });
    expect(invalid.statusCode).toBe(422);
    expect(f.projects.getProject(f.userId, id).name).toBe("Renamed again");
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

test("project provider instances include configured logins without profile references", async () => {
  const f = await nativeApp();
  try {
    f.database.authQuery((db) => db.prepare("INSERT INTO forge_provider_instances (id, provider, label, home_directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("instance_acmelaude", "claude-code", "acmelaude", "/private/acmelaude", "2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z"));

    const response = await f.app.inject({ method: "GET", url: `/api/projects/${f.project.id}/provider-instances`, headers: f.headers });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ instances: [{ id: "instance_acmelaude", provider: "claude-code", label: "acmelaude" }] });
    expect(response.body).not.toContain("homeDirectory");
    expect(response.body).not.toContain("/private/acmelaude");
    const defaultProviders = f.profiles.list(f.userId).filter((profile) => profile.id === f.project.rootProfileId || profile.id === f.project.workerProfileId).map((profile) => profile.provider);
    const saved = await f.app.inject({ method: "PATCH", url: `/api/projects/${f.project.id}`, headers: f.headers, payload: { providerPolicy: { allowedProviders: [...new Set([...defaultProviders, "claude-code"])], allowedInstanceIds: ["instance_acmelaude"] } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().providerPolicy.allowedInstanceIds).toEqual(["instance_acmelaude"]);
    const reloaded = await f.app.inject({ method: "GET", url: `/api/projects/${f.project.id}`, headers: f.headers });
    expect(reloaded.json().providerPolicy.allowedInstanceIds).toEqual(["instance_acmelaude"]);
  } finally {
    await f.close();
  }
});
