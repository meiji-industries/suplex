import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { loadConfig } from "../src/config.js";

const action = process.argv[2] ?? "up";
if (action !== "up" && action !== "down") {
  throw new Error(`Unsupported Compose action: ${action}`);
}

const config = loadConfig();
const temporalPort = config.temporalAddress.split(":").at(-1);
if (!temporalPort) {
  throw new Error(`Invalid Temporal address: ${config.temporalAddress}`);
}

const docker = process.env.FORGE_DOCKER_BIN
  ?? (existsSync("/Applications/OrbStack.app/Contents/MacOS/xbin/docker")
    ? "/Applications/OrbStack.app/Contents/MacOS/xbin/docker"
    : "docker");
const composeArguments = ["compose", "-f", "compose.dev.yaml", action];
if (action === "up") composeArguments.push("temporal");

const child = spawn(docker, composeArguments, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    FORGE_TEMPORAL_IMAGE: config.temporalImage,
    FORGE_TEMPORAL_NAMESPACE: config.temporalNamespace,
    FORGE_TEMPORAL_PORT: temporalPort,
    FORGE_TEMPORAL_VOLUME_NAME: `runtime-${config.installationId}-temporal-data`,
  },
  stdio: "inherit",
});

const forwardSignal = (signal: NodeJS.Signals): void => {
  child.kill(signal);
};
process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
