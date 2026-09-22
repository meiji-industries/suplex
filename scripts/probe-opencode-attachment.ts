import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CliHerdrClient } from "../src/integrations/herdr/client.js";
import { OpenCodeTaskRuntime, type OpenCodeTaskScope } from "../src/runtimes/opencode/task-runtime.js";
import { readOpenCodeServer, stopOpenCodeServer } from "../src/runtimes/opencode/server.js";

assert.equal(process.env.HERDR_ENV, "1", "Run this probe inside Herdr");
const directory = await mkdtemp(join(tmpdir(), "suplex-native-attachment-"));
const herdr = new CliHerdrClient();
const runtime = new OpenCodeTaskRuntime(join(directory, "suplex.sqlite"), herdr);
const scope: OpenCodeTaskScope = { id: "attachment-proof", taskId: "attachment-proof", role: "worker", workerMode: "planned", purpose: "implementation", workflow: "standard", evidenceRoot: null, directory, profile: { providerID: "openai", modelID: "gpt-5.6-luna", reasoningEffort: "max", serviceTier: "priority" } };
const panes = new Set<string>();
const workspaces = new Set<string>();
let paneId: string | null = null;
const persistPane = (id: string) => { paneId = id; panes.add(id); };
try {
  const nativeSessionId = await runtime.ensureSession(scope, null);
  const first = await runtime.attach({ scope, nativeSessionId, paneId, persistPane });
  await delay(1_000);
  const processInfo = await herdr.getPaneProcessInfo(first);
  assert.ok(processInfo.foreground_processes.some(value => value.argv?.includes(nativeSessionId)), "The visible TUI must attach to the native session");
  assert.equal(await runtime.attach({ scope, nativeSessionId, paneId, persistPane }), first, "Reconciliation must reuse the live attachment");
  const reference = await readOpenCodeServer(join(directory, "runtime", "task-sessions", scope.id));
  assert.ok(reference);
  await stopOpenCodeServer(reference);
  assert.equal(await runtime.ensureSession(scope, nativeSessionId), nativeSessionId);
  const recovered = await runtime.attach({ scope, nativeSessionId, paneId, persistPane });
  await delay(1_000);
  assert.equal(await runtime.attach({ scope, nativeSessionId, paneId, persistPane }), recovered);
  assert.ok((await herdr.getPaneProcessInfo(recovered)).foreground_processes.some(value => value.argv?.includes(nativeSessionId)));
  console.log(JSON.stringify({ directory, nativeSessionId, first, recovered, sameSessionAttachment: true }, null, 2));
} finally {
  const reference = await readOpenCodeServer(join(directory, "runtime", "task-sessions", scope.id));
  if (reference) await stopOpenCodeServer(reference);
  for (const id of panes) {
    const pane = await herdr.getPane(id);
    if (pane?.workspaceId) workspaces.add(pane.workspaceId);
    if (pane) await herdr.closePane(id);
  }
  for (const id of workspaces) if (await herdr.getWorkspace(id)) await herdr.closeWorkspace(id);
}
