import { z } from "zod";

import { runCommand as defaultRunCommand } from "./command-runner.js";
import type { HealthCheck } from "./health.js";
import { CliHerdrClient } from "./herdr-client.js";
import { json } from "./task-utils.js";

type Compatibility = "compatible" | "incompatible" | "unknown";

export type HerdrReadinessCommand = (input: {
  command: string;
  args: readonly string[];
  timeout: number;
}) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}>;

export interface HerdrReadinessOptions {
  command?: string;
  runCommand?: HerdrReadinessCommand;
  listWorkspaces?: () => Promise<unknown>;
}

type HerdrServerDiagnostic = {
  serverVersion: string | "unknown";
  privateProtocol: number | "unknown";
  privateProtocolCompatibility: Compatibility;
  endpointCompatibility: Compatibility;
};

const StatusSchema = z.object({
  status: z.string().optional(),
  running: z.boolean().optional(),
  version: z.string().min(1).optional(),
  protocol: z.number().int().nonnegative().optional(),
  compatible: z.boolean().optional(),
  endpoint_compatible: z.boolean().nullable().optional(),
}).passthrough();

const unknownServerDiagnostic = (): HerdrServerDiagnostic => ({
  serverVersion: "unknown",
  privateProtocol: "unknown",
  privateProtocolCompatibility: "unknown",
  endpointCompatibility: "unknown",
});

function compatibility(value: unknown): Compatibility {
  if (value === true || value === "yes" || value === "true") return "compatible";
  if (value === false || value === "no" || value === "false") return "incompatible";
  return "unknown";
}

function parseTextStatus(raw: string): HerdrServerDiagnostic | undefined {
  const fields = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (match) fields.set(match[1]!, match[2]!);
  }
  const version = fields.get("version");
  const protocolValue = fields.get("private_protocol") ?? fields.get("protocol");
  const protocol = protocolValue === undefined ? undefined : Number(protocolValue);
  const privateCompatibility = fields.get("private_protocol_compatible") ?? fields.get("compatible");
  if (!version || protocol === undefined || !Number.isInteger(protocol) || protocol < 0 || privateCompatibility === undefined) return undefined;
  return {
    serverVersion: version,
    privateProtocol: protocol,
    privateProtocolCompatibility: compatibility(privateCompatibility),
    endpointCompatibility: compatibility(fields.get("endpoint_compatible")),
  };
}

function parseServerStatus(raw: string): HerdrServerDiagnostic | undefined {
  const parsed = StatusSchema.safeParse(json(raw, undefined));
  if (!parsed.success) return parseTextStatus(raw);
  const status = parsed.data;
  if (status.running === false || (status.status !== undefined && status.status !== "running")) return undefined;
  if (status.version === undefined || status.protocol === undefined || status.compatible === undefined) return undefined;
  return {
    serverVersion: status.version,
    privateProtocol: status.protocol,
    privateProtocolCompatibility: compatibility(status.compatible),
    endpointCompatibility: compatibility(status.endpoint_compatible),
  };
}

function parseClientVersion(raw: string): string | "unknown" {
  return /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/.exec(raw)?.[0] ?? "unknown";
}

const execute: HerdrReadinessCommand = (input) => defaultRunCommand({
  taskId: null,
  stepId: null,
  command: input.command,
  args: input.args,
  timeout: input.timeout,
  expectNonZero: true,
});

async function commandOutput(runCommand: HerdrReadinessCommand, command: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await runCommand({ command, args, timeout: 3_000 });
    return result.exitCode === 0 && !result.timedOut ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

export async function checkHerdrReadiness(options: HerdrReadinessOptions = {}): Promise<HealthCheck> {
  const command = options.command ?? "herdr";
  const runCommand = options.runCommand ?? execute;
  const listWorkspaces = options.listWorkspaces ?? (() => new CliHerdrClient().listWorkspaces());
  const [versionOutput, statusOutput, apiReachable] = await Promise.all([
    commandOutput(runCommand, command, ["--version"]),
    commandOutput(runCommand, command, ["status", "server", "--json"]),
    listWorkspaces().then(() => true, () => false),
  ]);
  const clientVersion = versionOutput === undefined ? "unknown" : parseClientVersion(versionOutput);
  const server = statusOutput === undefined ? undefined : parseServerStatus(statusOutput);
  const diagnostic = server ?? unknownServerDiagnostic();
  const complete = clientVersion !== "unknown"
    && diagnostic.serverVersion !== "unknown"
    && diagnostic.privateProtocol !== "unknown"
    && diagnostic.privateProtocolCompatibility !== "unknown";
  const available = apiReachable && complete && diagnostic.privateProtocolCompatibility === "compatible";
  const status = !apiReachable ? "unhealthy" : available ? "healthy" : "warning";
  const summary = !apiReachable
    ? "Herdr API is not reachable. Check the Herdr server."
    : diagnostic.privateProtocolCompatibility === "incompatible"
      ? "Herdr API is reachable. Restart Herdr for terminal views."
      : available
        ? "Herdr API and terminal views are available"
        : "Herdr API is reachable. Check terminal compatibility.";

  return {
    id: "herdr-readiness",
    label: "Herdr readiness",
    status,
    summary,
    details: {
      apiReachable,
      clientVersion,
      serverVersion: diagnostic.serverVersion,
      privateProtocol: diagnostic.privateProtocol,
      privateProtocolCompatibility: diagnostic.privateProtocolCompatibility,
      endpointCompatibility: diagnostic.endpointCompatibility,
    },
  };
}

export function createHerdrReadinessCheck(options: HerdrReadinessOptions = {}): () => Promise<HealthCheck> {
  return () => checkHerdrReadiness(options);
}
