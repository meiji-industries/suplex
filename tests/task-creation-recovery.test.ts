import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ArtifactManifestEntrySchema, ArtifactStore } from "../src/artifacts.js";
import { canonicalJson } from "../src/canonical-json.js";
import { projectionStateHash } from "../src/database.js";
import { expectedInitialIssueWorkflowState, initialStateFixture } from "./fixtures/issue-state.js";

test("revision-zero state is one schema-parsed canonical value", () => {
  const fromCreation = initialStateFixture();
  const fromWorkflow = expectedInitialIssueWorkflowState();
  expect(canonicalJson(fromCreation)).toBe(canonicalJson(fromWorkflow));
  expect(projectionStateHash(fromCreation)).toBe(projectionStateHash(fromWorkflow));
});

// FROZEN: pins the SERIALIZED FIELD ORDER of IssueWorkflowState. Schema
// decomposition (contracts/state/*) must keep this byte-identical. If this
// fails after a schema refactor, the refactor reordered fields — fix the
// refactor, do not update the snapshot without human sign-off.
test("initial state serialized field order is frozen", () => {
  expect(JSON.stringify(initialStateFixture(), null, 2)).toMatchSnapshot();
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
