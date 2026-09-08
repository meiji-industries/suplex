import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { writeRootBridgeBinding } from "../src/runtimes/task-harness.js";

test("root bridge binding resolves source loader and bridge outside the runtimes domain", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "forge-root-binding-"));
  try {
    const server = await writeRootBridgeBinding({ runtimeDirectory, identity: { taskId: "task-1", sessionId: "root-1", generation: 1 }, databasePath: join(runtimeDirectory, "forge.sqlite"), artifactRoot: undefined });
    expect(server.args).toHaveLength(4);
    expect(existsSync(server.args[0]!)).toBe(true);
    expect(existsSync(server.args[1]!)).toBe(true);
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
