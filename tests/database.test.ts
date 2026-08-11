import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ForgeDatabase } from "../src/database.js";

test("initializes migrations in WAL mode and preserves probe state after reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-db-test-"));
  const filename = join(root, "forge.sqlite");

  try {
    const first = new ForgeDatabase(filename);
    first.recordProbe({
      workflowId: "probe-workflow-1",
      probeId: "probe-1",
      companyId: "company-1",
      status: "running",
    });
    assert.equal(first.health().walMode, true);
    first.close();

    const reopened = new ForgeDatabase(filename);
    assert.deepEqual(reopened.getProbe("probe-1"), {
      workflowId: "probe-workflow-1",
      probeId: "probe-1",
      companyId: "company-1",
      status: "running",
    });
    assert.equal(reopened.health().migrationVersion, 1);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
