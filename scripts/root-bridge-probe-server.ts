import { appendFile, readFile } from "node:fs/promises";

import { RootBridge, startRootBridgeTransport, type RootBridgeAdapter } from "../src/root-bridge.js";
import { RootBridgeConfigSchema, type RootIdentity } from "../src/root-contracts.js";

const [bindingPath, callsPath] = process.argv.slice(2);

if (!bindingPath || !callsPath) throw new Error("root bridge probe requires binding and calls paths");

const config = RootBridgeConfigSchema.parse(JSON.parse(await readFile(bindingPath, "utf8")));
const record = async (value: unknown): Promise<void> => appendFile(callsPath, `${JSON.stringify(value)}\n`);

const adapter: RootBridgeAdapter = {
  async readImage(): Promise<never> { throw new Error("No image in this probe"); },
  async claimToolOwner(): Promise<string | null> { return "probe-token"; },
  async releaseToolOwner(): Promise<void> {},
  async assertCurrentRoot(root: RootIdentity): Promise<void> {
    if (root.taskId !== config.root.taskId || root.sessionId !== config.root.sessionId || root.generation !== config.root.generation)
      throw new Error("probe Root binding did not match");
    await record({ kind: "assert", root });
  },
  async observe(root: RootIdentity): Promise<unknown> {
    await record({ kind: "observe", root });
    return { observedTaskId: root.taskId };
  },
  async delegateWorker(root, assignment): Promise<unknown> {
    await record({ kind: "delegate_worker", root, ...assignment });
    return { assignmentId: "probe-worker" };
  },
  async delegateAdvisor(root, request): Promise<unknown> {
    await record({ kind: "delegate_advisor", root, ...request });
    return { assignmentId: "probe-advisor" };
  },
  async requestDelivery(): Promise<unknown> {
    throw new Error("probe does not permit delivery");
  },
  async askHuman(): Promise<unknown> {
    throw new Error("probe does not permit human questions");
  },
};

startRootBridgeTransport({ bridge: new RootBridge(config.root, adapter), stdin: process.stdin, stdout: process.stdout });
