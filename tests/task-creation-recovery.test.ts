import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ArtifactManifestEntrySchema, ArtifactStore } from "../src/artifacts.js";
import { canonicalJson } from "../src/canonical-json.js";
import { projectionStateHash } from "../src/database.js";
import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema } from "../src/temporal/issue-contracts.js";

const input = {
  workflowId: "workflow-installation-issue-task-recovery",
  companyId: "company-recovery",
  projectId: "project-recovery",
  issueId: "task-recovery",
  projectRevisionId: "revision-recovery",
  briefArtifactId: "artifact-brief",
  briefSha256: "a".repeat(64),
  imageArtifactIds: [],
  requestHash: "b".repeat(64),
  roleProfiles: { lead: "profile-lead" },
  supplementalReview: false,
  repairCycleLimit: 2,
};

test("revision-zero state is one schema-parsed canonical value", () => {
  const fromCreation = buildInitialIssueWorkflowState(input);
  const fromWorkflow = IssueWorkflowStateSchema.parse({
    workflowId: input.workflowId,
    companyId: input.companyId,
    projectId: input.projectId,
    issueId: input.issueId,
    projectRevisionId: input.projectRevisionId,
    requestHash: input.requestHash,
    phase: "backlog",
    revision: 0,
    owner: "human",
    allowedCommands: ["start_planning"],
    pendingAction: "Start planning",
    lastEventId: `${input.workflowId}:0`,
    continuationCount: 0,
    lastSummaryHash: null,
    repairCycle: 0,
  });

  expect(canonicalJson(fromCreation)).toBe(canonicalJson(fromWorkflow));
  expect(projectionStateHash(fromCreation)).toBe(projectionStateHash(fromWorkflow));
});

test("an artifact manifest is persisted before bytes and cleanup is exact", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifact-recovery-test-"));
  try {
    const store = new ArtifactStore(root);
    const bytes = Buffer.from("brief body", "utf8");
    const planned = store.plan("company-recovery", "creation-recovery", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes });
    const manifest = ArtifactManifestEntrySchema.parse(planned);
    await expect(stat(join(root, planned.stagingPath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, planned.storagePath))).rejects.toMatchObject({ code: "ENOENT" });

    const stored = await store.write(planned, bytes);
    expect(stored.storagePath).toBe(manifest.storagePath);
    expect(await store.read(stored)).toEqual(bytes);
    await store.removePlanned(planned);
    await expect(stat(join(root, planned.stagingPath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, planned.storagePath))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
