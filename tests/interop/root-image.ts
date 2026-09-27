// Exercise the Rust Root MCP image boundary against a disposable native installation.
import { deepStrictEqual, equal, match } from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeFixture } from "../helpers/native-browser.js";
import { nativeRootBridge } from "../helpers/native-root-bridge.js";
import { initializeAndList, runMcpProcess } from "../helpers/mcp-process.js";

const fixture = await nativeFixture();
try {
  const image = { filename: "design.png", mimeType: "image/png" as const, base64: "iVBORw0KGgo=" };
  const task = await fixture.createTask({ title: "Inspect attached design", idempotencyKey: "root-image-interop-1", startImmediately: false, images: [image] });
  const foreign = await fixture.createTask({ title: "Foreign attachment", idempotencyKey: "root-image-interop-2", startImmediately: false, images: [image] });
  const { server } = await nativeRootBridge(fixture, task.id);
  const denied = await runMcpProcess(server, { ...process.env, ...server.environment, SUPLEX_ROOT_TOKEN: "invalid-token" }, initializeAndList);
  equal(denied.responses.some((candidate) => typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === 1), false);
  equal(denied.exitCode === 0, false);
  const call = async (artifactId: string) => {
    const result = await runMcpProcess(server, { ...process.env, ...server.environment }, [
      ...initializeAndList,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: { kind: "read_image", artifactId } } },
    ]);
    const response = result.responses.find((candidate): candidate is { id: number; result: { content?: unknown; isError?: boolean } } =>
      typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === 3);
    if (!response) throw new Error(`Rust MCP image response is missing: ${result.stderr}`);
    return response.result;
  };
  const id = task.images[0]!.artifactId;
  const accepted = await call(id);
  equal(accepted.isError, false);
  deepStrictEqual(accepted.content, [
    { type: "text", text: image.filename },
    { type: "image", data: image.base64, mimeType: image.mimeType },
  ]);
  equal((await call(foreign.images[0]!.artifactId)).isError, true);
  const artifact = fixture.database.prepare("SELECT storage_path FROM suplex_artifacts WHERE id = ?").get(id) as { storage_path: string };
  await writeFile(join(fixture.config.artifactRoot, artifact.storage_path), "changed");
  const corrupted = await call(id);
  equal(corrupted.isError, true);
  match(JSON.stringify(corrupted.content), /changed in storage/);
  fixture.database.prepare("UPDATE suplex_task_controls SET status = 'cancelled' WHERE task_id = ?").run(task.id);
  equal((await call(id)).isError, true);
  console.log("Rust Root MCP reads authorized image bytes and refuses foreign, changed, and cancelled images.");
} finally {
  await fixture.close();
}
