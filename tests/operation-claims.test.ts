import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { claimOperation, operationKey, settleOperation } from "../src/operation-claims.js";

test("operation claims settle once and expose the existing result to duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-operation-claims-"));
  const database = new ForgeDatabase(createTestConfig(root).databasePath);
  try {
    const key = operationKey(["push", "task_1", "forge/task_1", "a".repeat(40)]);
    expect(claimOperation(database, { key, taskId: "task_1", kind: "push" })).toEqual({ claimed: true });
    settleOperation(database, key, "settled", { pushed: true });
    expect(claimOperation(database, { key, taskId: "task_1", kind: "push" })).toEqual({ claimed: false, status: "settled", result: { pushed: true } });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
