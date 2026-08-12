import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { expect, test } from "vitest";

import { cleanupAgentWrapper, createAgentWrapperManifest, inspectAgentWrapper, launchAgentWrapper, runAgentWrapper } from "../src/agent-wrapper.js";
import { defaultProcessController, inspectDurableExecution } from "../src/execution-recovery.js";

test("durable wrapper writes private output and an atomic terminal result", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-agent-wrapper-test-"));
  try {
    const directory = await createAgentWrapperManifest({ runtimeRoot: root, executionId: "agent-test", command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({type:'done'})); process.stderr.write('diagnostic')"], cwd: root });
    await runAgentWrapper(directory.manifestPath);
    const inspection = await inspectAgentWrapper(directory.manifestPath);
    expect(inspection.live).toBe(false);
    expect(inspection.result).toMatchObject({ exitCode: 0 });
    expect(await readFile(directory.stdoutPath, "utf8")).toContain("type");
    expect(await readFile(directory.stderrPath, "utf8")).toBe("diagnostic");
    await cleanupAgentWrapper(root, "agent-test");
    await expect(access(directory.directory)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a detached launcher records the wrapper's actual process group for ownership proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-agent-wrapper-launch-test-"));
  try {
    const directory = await createAgentWrapperManifest({ runtimeRoot: root, executionId: "agent-launch-test", command: "/bin/sleep", args: ["30"], cwd: root });
    await launchAgentWrapper(directory.manifestPath, { command: join(process.cwd(), "node_modules/.bin/tsx"), args: [join(process.cwd(), "src/cli.ts")] });
    let inspection = await inspectAgentWrapper(directory.manifestPath);
    for (let attempt = 0; attempt < 100 && !inspection.state?.childPid; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await inspectAgentWrapper(directory.manifestPath);
    }
    expect(inspection.state?.childPid).toEqual(expect.any(Number));
    const state = inspection.state!;
    const ownership = await inspectDurableExecution({ controller: defaultProcessController, executionId: "agent-launch-test", wrapperPath: directory.directory, expectedCwd: root, processPid: state.childPid!, processGroupId: state.childProcessGroupId!, processStartIdentity: state.childStartIdentity! });
    expect(ownership.status).toBe("live");
    await defaultProcessController.signalGroup(state.childProcessGroupId!, "SIGTERM");
    for (let attempt = 0; attempt < 100 && !inspection.result; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await inspectAgentWrapper(directory.manifestPath);
    }
    expect(inspection.result).toMatchObject({ exitCode: -1 });
    await cleanupAgentWrapper(root, "agent-launch-test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
