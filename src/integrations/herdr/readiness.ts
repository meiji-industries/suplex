import { z } from "zod";

import { runCommand as defaultRunCommand } from "../../platform/command-runner.js";
import type { HealthCheck } from "../../platform/health.js";
import { CliHerdrClient } from "./client.js";
import { json } from "../../shared/json.js";

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

type ProbeOutcome = { kind: "ok"; stdout: string } | { kind: "missing" } | { kind: "ambiguous" };

async function probe(runCommand: HerdrReadinessCommand, command: string, args: readonly string[]): Promise<ProbeOutcome> {
  try {
    const result = await runCommand({ command, args, timeout: 3_000 });
    return result.exitCode === 0 && !result.timedOut ? { kind: "ok", stdout: result.stdout } : { kind: "ambiguous" };
  } catch (error) {
    // Only a spawn ENOENT proves the CLI is absent. Timeouts and other failures are ambiguous.
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? { kind: "missing" } : { kind: "ambiguous" };
  }
}

function herdrInstallRemedy(): Pick<HealthCheck, "remedy" | "remedyKind"> {
  // Sources: https://herdr.dev install scripts, including the documented Windows PowerShell installer.
  return process.platform === "win32"
    ? { remedy: "https://herdr.dev", remedyKind: "link" }
    : { remedy: "curl -fsSL https://herdr.dev/install.sh | sh" };
}

function check(status: HealthCheck["status"], summary: string, details: Record<string, string | number | boolean>, remedy?: Pick<HealthCheck, "remedy" | "remedyKind">): HealthCheck {
  return { id: "herdr-readiness", label: "Herdr", status, summary, ...(remedy ?? {}), details };
}

export async function checkHerdrReadiness(options: HerdrReadinessOptions = {}): Promise<HealthCheck> {
  const command = options.command ?? "herdr";
  const runCommand = options.runCommand ?? execute;
  const listWorkspaces = options.listWorkspaces ?? (() => new CliHerdrClient().listWorkspaces());
  const [version, status, apiReachable] = await Promise.all([
    probe(runCommand, command, ["--version"]),
    probe(runCommand, command, ["status", "server", "--json"]),
    listWorkspaces().then(() => true, () => false),
  ]);

  if (version.kind === "missing") {
    return check("unhealthy", "Herdr is not installed", { cliPresent: false, apiReachable }, herdrInstallRemedy());
  }

  const clientVersion = version.kind === "ok" ? parseClientVersion(version.stdout) : "unknown";
  const server = status.kind === "ok" ? parseServerStatus(status.stdout) : undefined;
  const diagnostic = server ?? unknownServerDiagnostic();
  const details = {
    apiReachable,
    cliPresent: version.kind === "ok" ? true : "unknown",
    clientVersion,
    serverVersion: diagnostic.serverVersion,
    privateProtocol: diagnostic.privateProtocol,
    privateProtocolCompatibility: diagnostic.privateProtocolCompatibility,
    endpointCompatibility: diagnostic.endpointCompatibility,
  };

  if (!apiReachable) {
    if (version.kind === "ambiguous" && status.kind !== "ok") {
      return check("warning", "Suplex could not check Herdr", { ...details, failure: "probe-ambiguous" });
    }
    // The CLI answered but the socket API did not: the server is not running.
    return check("unhealthy", "Suplex cannot reach Herdr", { ...details, failure: "api-unreachable" }, { remedy: "herdr" });
  }

  if (diagnostic.privateProtocolCompatibility === "incompatible") {
    return check("warning", "Restart Herdr for terminal views", { ...details, failure: "protocol-incompatible" }, { remedy: "herdr server stop && herdr" });
  }

  if (status.kind !== "ok" || !server) {
    // The API answered, so Herdr runs; only its status output is missing or unrecognized.
    return check("warning", "Herdr diagnostics are incomplete", { ...details, failure: "diagnostics-incomplete" }, { remedy: "herdr status" });
  }

  if (clientVersion === "unknown") {
    return check("warning", "Suplex could not check Herdr", { ...details, failure: "probe-ambiguous" });
  }

  return check("healthy", "Herdr API and terminal views are available", details);
}

export function createHerdrReadinessCheck(options: HerdrReadinessOptions = {}): () => Promise<HealthCheck> {
  return () => checkHerdrReadiness(options);
}
