import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { ArtifactStore, type StoredArtifact } from "../src/artifacts.js";
import { ForgeDatabase } from "../src/database.js";
import { developerVerificationProjection } from "../src/developer-task-projection.js";
import { reconcileDeveloperDelivery } from "../src/developer-reconciliation.js";

const sha = "a".repeat(64);
const now = "2026-08-01T00:00:00.000Z";
const authorization = { authorizationId: "authorization_1", taskId: "task_1", companyId: "company_1", projectId: "project_1", workflowId: "workflow_1", planRevision: 1, planArtifactId: "plan_1", planSha256: sha, authorizationKind: "routine_auto" as const, approvalDecisionId: null, authorizedAt: now };
const manifest = { version: 1 as const, authorizedPlan: authorization, projectRevision: { projectRevisionId: "revision_1", projectId: "project_1", companyId: "company_1", repositoryIdentity: "owner/repo", repositoryPath: "/repo", worktreeRoot: "/worktrees", baseBranch: "main", targetBranch: "main", baseSha: "a".repeat(40), targetSha: "a".repeat(40), setupVerificationPolicySha256: sha }, entries: [{ kind: "final_plan" as const, artifactId: "plan_1", repositoryPath: null, sha256: sha, byteSize: 1, stagedFilename: "plan.json", planStepNumbers: [1] }], contradictionRule: "stop_before_unrelated_edits" as const, verificationCommands: [{ stepNumber: 1, commands: ["pnpm test"] }], createdAt: now };
const reconciliation = reconcileDeveloperDelivery({ executionId: "developer_1", companyId: "company_1", report: { kind: "delivery", summary: "done", steps: [{ number: 1, status: "completed", filesChanged: ["README.md"], notes: "done" }], authorizedStepsNotCompleted: [], resultCommit: "b".repeat(40), resultTree: "c".repeat(40), dirtyState: "clean", blocker: null }, independentVerification: { outcome: "passed", summary: "passed", commands: [{ command: "pnpm test", argv: ["pnpm", "test"], exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" }] }, git: { branch: "work/task", head: "b".repeat(40), tree: "c".repeat(40), status: "", parents: ["a".repeat(40)], commitCount: 1, isDescendant: true, changedPaths: ["README.md"] }, startingSha: "a".repeat(40), neutralBranch: "work/task", providerBeforeSha256: sha, providerAfterSha256: sha, processExitCode: 0, developerSessionId: "developer", leadSessionId: "lead", authorization, manifest, requiredChecks: [] });
const empty = { verificationCommands: [], verificationResults: [] };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-developer-projection-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  database.authTransaction((db) => {
    for (const [id, name] of [["company_1", "Company 1"], ["company_2", "Company 2"]]) db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES (?, ?, 'active', ?)").run(id, name, now);
  });
  cleanups.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });

  const register = async (companyId: string, kind: StoredArtifact["kind"], value: unknown, filename = `${kind}.json`) => {
    const artifact = await artifacts.put(companyId, kind, { filename, mimeType: "application/json", bytes: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) });
    database.authTransaction((db) => db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt));
    return artifact;
  };
  const project = (manifestId: string | null, reconciliationId: string | null, companyId = "company_1") => developerVerificationProjection(database, artifacts, companyId, manifestId, reconciliationId);
  return { database, register, project };
}

test("projects exact commands and integrity-checked policy-v2 verification", async () => {
  const { register, project } = await fixture();
  const manifestArtifact = await register("company_1", "developer-evidence-manifest", manifest);
  const reconciliationArtifact = await register("company_1", "developer-reconciliation", reconciliation);
  expect(project(manifestArtifact.id, reconciliationArtifact.id)).toEqual({ verificationCommands: [{ stepNumber: 1, commands: ["pnpm test"] }], verificationResults: ["pnpm test: passed"] });

  const failedArtifact = await register("company_1", "developer-reconciliation", { ...reconciliation, independentVerification: { ...reconciliation.independentVerification!, outcome: "failed", summary: "timed out" } });
  expect(project(null, failedArtifact.id)).toEqual({ verificationCommands: [], verificationResults: ["Verification failed: timed out"] });

  const legacyArtifact = await register("company_1", "developer-reconciliation", { ...reconciliation, policyVersion: undefined, independentVerification: undefined });
  expect(project(null, legacyArtifact.id)).toEqual(empty);
});

test("enforces artifact company, kind, schema, and registered hash", async () => {
  const { database, register, project } = await fixture();
  expect(project("missing", "missing")).toEqual(empty);

  const wrongCompany = await register("company_2", "developer-evidence-manifest", manifest);
  const wrongKind = await register("company_1", "developer-delivery", reconciliation);
  const malformed = await register("company_1", "developer-reconciliation", "{not-json");
  const hashMismatch = await register("company_1", "developer-reconciliation", reconciliation);
  database.authTransaction((db) => db.prepare("UPDATE forge_artifacts SET sha256 = ? WHERE id = ?").run("f".repeat(64), hashMismatch.id));

  expect(project(wrongCompany.id, null)).toEqual(empty);
  expect(project(null, wrongKind.id)).toEqual(empty);
  expect(project(null, malformed.id)).toEqual(empty);
  expect(project(null, hashMismatch.id)).toEqual(empty);
});

test("degrades optional evidence independently and never falls back to raw report claims", async () => {
  const { database, register, project } = await fixture();
  const validManifest = await register("company_1", "developer-evidence-manifest", manifest);
  const validReconciliation = await register("company_1", "developer-reconciliation", reconciliation);
  const corruptManifest = await register("company_1", "developer-evidence-manifest", manifest);
  const corruptReconciliation = await register("company_1", "developer-reconciliation", reconciliation);
  database.authTransaction((db) => db.prepare("UPDATE forge_artifacts SET sha256 = ? WHERE id IN (?, ?)").run("f".repeat(64), corruptManifest.id, corruptReconciliation.id));

  expect(project(validManifest.id, corruptReconciliation.id)).toEqual({ verificationCommands: [{ stepNumber: 1, commands: ["pnpm test"] }], verificationResults: [] });
  expect(project(corruptManifest.id, validReconciliation.id)).toEqual({ verificationCommands: [], verificationResults: ["pnpm test: passed"] });

  const rawReport = await register("company_1", "developer-delivery-raw", { commandsRun: ["pnpm test"], testResults: ["claimed pass"] });
  expect(project(null, rawReport.id)).toEqual(empty);
});
