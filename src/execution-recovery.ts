import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { inspectAgentWrapper, readProcessStartIdentity, type WrapperInspection } from "./agent-wrapper.js";

const execFileAsync = promisify(execFile);

export interface ProcessInspection {
  pid: number;
  processGroupId: number;
  processStartIdentity: string;
  command: string;
}

export interface ProcessController {
  inspect(pid: number): Promise<ProcessInspection | undefined>;
  signalGroup(processGroupId: number, signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export type DurableExecutionInspection =
  | { status: "live"; wrapper: WrapperInspection }
  | { status: "terminal_result"; wrapper: WrapperInspection }
  | { status: "missing" | "identity_mismatch" };

export const defaultProcessController: ProcessController = {
  async inspect(pid) {
    try {
      const result = await execFileAsync("ps", ["-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-o", "command="], { maxBuffer: 32 * 1024 });
      const tokens = result.stdout.trim().split(/\s+/);
      if (tokens.length < 8) return undefined;
      const actualPid = Number(tokens[0]);
      const processGroupId = Number(tokens[1]);
      const processStartIdentity = await readProcessStartIdentity(pid);
      const command = tokens.slice(7).join(" ");
      if (!Number.isInteger(actualPid) || actualPid !== pid || !Number.isInteger(processGroupId) || !processStartIdentity || !command) return undefined;
      return { pid, processGroupId, processStartIdentity, command };
    } catch {
      return undefined;
    }
  },
  async signalGroup(processGroupId, signal) {
    if (!Number.isInteger(processGroupId) || processGroupId <= 1) throw new Error("Refusing to signal an unsafe process group");
    process.kill(-processGroupId, signal);
  },
};

export function matchesProcessIdentity(expected: { processPid: number; processGroupId: number; processStartIdentity: string }, actual: ProcessInspection): boolean {
  return expected.processPid === actual.pid
    && expected.processGroupId === actual.processGroupId
    && expected.processStartIdentity === actual.processStartIdentity;
}

export async function inspectDurableExecution(input: {
  controller: ProcessController;
  executionId: string;
  wrapperPath: string;
  processPid: number;
  processGroupId: number;
  processStartIdentity: string;
  expectedCwd?: string;
}): Promise<DurableExecutionInspection> {
  const wrapper = await inspectAgentWrapper(`${input.wrapperPath}/manifest.json`).catch(() => undefined);
  if (!wrapper) return { status: "missing" };
  if (wrapper.manifest.executionId !== input.executionId || (input.expectedCwd && wrapper.manifest.cwd !== input.expectedCwd)) return { status: "identity_mismatch" };
  if (wrapper.result) return { status: "terminal_result", wrapper };
  const state = wrapper.state;
  if (!state || !["starting", "running"].includes(state.status) || !state.childPid || !state.childProcessGroupId || !state.childStartIdentity) return { status: "identity_mismatch" };
  const [wrapperProcess, childProcess] = await Promise.all([input.controller.inspect(state.wrapperPid), input.controller.inspect(state.childPid)]);
  if (!wrapperProcess || wrapperProcess.processGroupId !== state.wrapperProcessGroupId || wrapperProcess.processStartIdentity !== state.wrapperStartIdentity) return { status: "identity_mismatch" };
  if (!childProcess || !matchesProcessIdentity({ processPid: input.processPid, processGroupId: input.processGroupId, processStartIdentity: input.processStartIdentity }, childProcess)) return { status: "identity_mismatch" };
  if (state.childPid !== input.processPid || state.childProcessGroupId !== input.processGroupId || state.childStartIdentity !== input.processStartIdentity) return { status: "identity_mismatch" };
  return { status: "live", wrapper };
}

export async function terminateOwnedProcessGroup(input: {
  controller: ProcessController;
  processPid: number;
  processGroupId: number;
  processStartIdentity: string;
  isTerminal: () => Promise<boolean>;
}): Promise<boolean> {
  const { controller, processPid, processGroupId, processStartIdentity, isTerminal } = input;
  const owned = await controller.inspect(processPid);
  if (!owned || !matchesProcessIdentity({ processPid, processGroupId, processStartIdentity }, owned)) return false;
  await controller.signalGroup(processGroupId, "SIGTERM");
  const waitForTerminal = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await isTerminal()) return true;
      const current = await controller.inspect(processPid);
      if (!current) return true;
      if (!matchesProcessIdentity({ processPid, processGroupId, processStartIdentity }, current)) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };
  if (await waitForTerminal()) return true;
  const afterGrace = await controller.inspect(processPid);
  if (afterGrace && matchesProcessIdentity({ processPid, processGroupId, processStartIdentity }, afterGrace)) {
    await controller.signalGroup(processGroupId, "SIGKILL");
  }
  return waitForTerminal();
}
