// Run after building the Rust binary with SUPLEX_RUST_BIN set to that binary.
import { deepStrictEqual, equal, match } from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RootController } from "../../src/coordination/root-controller.js";
import { ArtifactStore } from "../../src/platform/artifacts.js";
import { writeRootBridgeBinding } from "../../src/runtimes/task-harness.js";
import { FakeTaskHarness } from "../helpers/fake-task-harness.js";
import { initializeAndList, runMcpProcess } from "../helpers/mcp-process.js";
import { nativeApp } from "../helpers/native-app.js";

const fixture = await nativeApp();
try {
  const image = { filename: "design.png", mimeType: "image/png" as const, base64: "iVBORw0KGgo=" };
  const created = await fixture.tasks.createTask(fixture.userId, fixture.company.id, {
    projectId: fixture.project.id,
    title: "Inspect attached design",
    idempotencyKey: "root-image-interop-1",
    startImmediately: true,
    images: [image],
  });
  const foreign = await fixture.tasks.createTask(fixture.userId, fixture.company.id, {
    projectId: fixture.project.id,
    title: "Foreign attachment",
    idempotencyKey: "root-image-interop-2",
    images: [image],
  });
  const controller = new RootController(
    fixture.tasks.repository.controls,
    new FakeTaskHarness(),
    undefined,
    new ArtifactStore(fixture.config.artifactRoot),
  );
  const root = controller.prepareRoot(created.task.id);
  const identity = { taskId: created.task.id, sessionId: root.id, generation: root.generation };
  const binding = await writeRootBridgeBinding({
    runtimeDirectory: join(fixture.directory, "root-image-bridge"),
    identity,
    databasePath: fixture.config.databasePath,
    artifactRoot: fixture.config.artifactRoot,
  });
  const server = {
    ...binding,
    command: resolve(process.env.SUPLEX_RUST_BIN ?? "rust/target/debug/suplex"),
    args: ["mcp", "root"],
  };
  const call = async (artifactId: string) => {
    const result = await runMcpProcess(server, { ...process.env, ...binding.environment }, [
      ...initializeAndList,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: { kind: "read_image", artifactId } } },
    ]);
    const response = result.responses.find((candidate): candidate is { id: number; result: { content?: unknown; isError?: boolean } } =>
      typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === 3);
    if (!response) throw new Error(`Rust MCP image response is missing: ${result.stderr}`);
    return response.result;
  };
  const id = created.task.images[0]!.artifactId;
  const source = await controller.readImage(identity, id);
  const accepted = await call(id);
  equal(accepted.isError, false);
  deepStrictEqual(accepted.content, [
    { type: "text", text: source.filename },
    { type: "image", data: source.data, mimeType: source.mimeType },
  ]);
  equal((await call(foreign.task.images[0]!.artifactId)).isError, true);

  const artifact = fixture.tasks.repository.controls.image(created.task.id, id);
  await writeFile(join(fixture.config.artifactRoot, artifact.storagePath), "changed");
  const corrupted = await call(id);
  equal(corrupted.isError, true);
  match(JSON.stringify(corrupted.content), /changed in storage/);
  fixture.tasks.cancelTask(fixture.userId, created.task.id);
  equal((await call(id)).isError, true);
  console.log("Rust Root MCP image content matches TypeScript; foreign, changed, and cancelled reads are refused.");
} finally {
  await fixture.close();
}
