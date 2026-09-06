import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { CliHerdrClient } from "../src/herdr-client.js";
import { prepareArchiveDisplays } from "../src/task-archive-displays.js";

test("archive closes a real owned Herdr workspace and all its panes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-archive-display-proof-"));
  const taskId = `task_archive_proof_${randomUUID()}`;
  const herdr = new CliHerdrClient();
  const { workspace, rootPane } = await herdr.createWorkspace({ label: `forge-${taskId}`, cwd: directory, focus: false });
  try {
    const worker = await herdr.splitPane({ paneId: rootPane.paneId, direction: "right", cwd: directory, focus: false });
    for (const pane of [rootPane, worker]) {
      await herdr.reportPaneMetadata({ paneId: pane.paneId, source: "forge", title: "Archive cleanup proof", tokens: { forge_task_id: taskId, forge_binding_id: "proof-session" } });
      await herdr.runPaneCommand(pane.paneId, "exec /bin/zsh -f");
      await expect.poll(async () => {
        const info = await herdr.getPaneProcessInfo(pane.paneId);
        return info.foreground_processes.length > 0 && info.foreground_processes.every(process => process.pid === info.shell_pid && process.name === "zsh" && process.argv?.includes("-f"));
      }, { timeout: 10_000 }).toBe(true);
    }
    const close = await prepareArchiveDisplays([{ id: "proof-session", taskId, paneId: rootPane.paneId, nativeSessionId: null, server: null }], herdr);
    await close();
    expect(await herdr.getWorkspace(workspace.workspaceId)).toBeNull();
    expect(await herdr.getPane(rootPane.paneId)).toBeNull();
    expect(await herdr.getPane(worker.paneId)).toBeNull();
    await close();
  } finally {
    if (await herdr.getWorkspace(workspace.workspaceId)) await herdr.closeWorkspace(workspace.workspaceId);
    await rm(directory, { recursive: true, force: true });
  }
});
