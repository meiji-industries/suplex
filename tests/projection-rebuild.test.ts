import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectionRebuildService } from "../src/projection-rebuild.js";

test("projection rebuild reports Temporal unavailability instead of using SQLite snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-rebuild-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    const service = new ProjectionRebuildService(database, createTestConfig(root, { temporalAddress: "127.0.0.1:1" }));
    await expect(service.rebuild()).rejects.toMatchObject({ code: "temporal_rebuild_unavailable" });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
