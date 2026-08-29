import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { ProjectionRebuildService } from "../src/projection-rebuild.js";

test("projection rebuild uses durable SQLite snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-rebuild-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    const service = new ProjectionRebuildService(database, createTestConfig(root));
    await expect(service.rebuild()).resolves.toEqual({ rebuilt: 0, findings: [] });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
