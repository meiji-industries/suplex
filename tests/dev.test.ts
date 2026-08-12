import { expect, test } from "vitest";

import { resolveDevPorts } from "../scripts/dev.js";
import { isForgeDevelopmentCommand, parseProcessList } from "../scripts/down.js";

test("reserves a Conductor port block without changing standalone defaults", () => {
  expect(resolveDevPorts(undefined)).toEqual({ temporal: 7233, temporalUi: 8233 });
  expect(resolveDevPorts("55000")).toEqual({ forge: 55000, temporal: 55001, temporalUi: 55002 });
  expect(() => resolveDevPorts("65534")).toThrow(/three valid ports/);
});

test("recognizes only Forge development process commands", () => {
  expect(isForgeDevelopmentCommand("temporal server start-dev --port 7233 --db-filename .forge/dev/temporal.db --namespace forge-dev")).toBe(true);
  expect(isForgeDevelopmentCommand("/opt/node --import tsx scripts/dev.ts")).toBe(true);
  expect(isForgeDevelopmentCommand("/opt/node --import tsx src/cli.ts start --foreground")).toBe(true);
  expect(isForgeDevelopmentCommand("/opt/node /repo/node_modules/tsx/dist/cli.mjs watch --clear-screen=false src/server.ts")).toBe(true);
  expect(isForgeDevelopmentCommand("temporal server start-dev --db-filename /tmp/other.db")).toBe(false);
  expect(isForgeDevelopmentCommand("/opt/node /other/server.ts")).toBe(false);
});

test("parses pid, process group, and complete command from ps output", () => {
  expect(parseProcessList("  41   39 temporal server start-dev --port 7233\n  52   52 node --import tsx scripts/dev.ts\n")).toEqual([
    { pid: 41, processGroup: 39, command: "temporal server start-dev --port 7233" },
    { pid: 52, processGroup: 52, command: "node --import tsx scripts/dev.ts" },
  ]);
});
