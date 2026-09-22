import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { writeRootBridgeBinding } from "../src/runtimes/task-harness.js";
import { RootBridgeConfigSchema } from "../src/coordination/root-contracts.js";

test("root bridge binding resolves source loader and bridge outside the runtimes domain", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "suplex-root-binding-"));
  try {
    const server = await writeRootBridgeBinding({ runtimeDirectory, identity: { taskId: "task-1", sessionId: "root-1", generation: 1 }, databasePath: join(runtimeDirectory, "suplex.sqlite"), artifactRoot: undefined });
    expect(server.args).toHaveLength(2);
    expect(existsSync(server.args[0]!)).toBe(true);
    expect(existsSync(server.args[1]!)).toBe(true);
    const bindingPath = join(runtimeDirectory, "root.binding.json");
    const first = RootBridgeConfigSchema.parse(JSON.parse(await readFile(bindingPath, "utf8")));
    expect(first.token).toMatch(/^[0-9a-f-]{36}$/);
    expect((await stat(bindingPath)).mode & 0o777).toBe(0o600);
    const repeated = await writeRootBridgeBinding({ runtimeDirectory, identity: first.root, databasePath: join(runtimeDirectory, "suplex.sqlite"), artifactRoot: first.artifactRoot });
    expect(RootBridgeConfigSchema.parse(JSON.parse(await readFile(bindingPath, "utf8"))).token).toBe(first.token);
    expect(repeated.environment.SUPLEX_ROOT_TOKEN).toBe(first.token);
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
