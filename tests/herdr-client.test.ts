import { expect, test } from "vitest";

import {
  CliHerdrClient,
  type HerdrFailure,
} from "../src/integrations/herdr/client.js";
import type { CommandRunResult } from "../src/platform/command-runner.js";

test("process observations retain foreground argv and reject another pane's identity", async () => {
  const calls: string[][] = [];
  const client = new CliHerdrClient("herdr", async (_file, args) => {
    calls.push([...args]);
    return { stdout: JSON.stringify({ id: "process", result: { process_info: { pane_id: "w1:p2", shell_pid: 10, foreground_process_group_id: 11, foreground_processes: [{ pid: 11, name: "opencode", argv: ["/bin/opencode", "attach"] }] } } }) };
  });
  expect((await client.getPaneProcessInfo("w1:p2")).foreground_processes[0]?.argv).toEqual(["/bin/opencode", "attach"]);
  expect(calls).toEqual([["pane", "process-info", "--pane", "w1:p2"]]);
  await expect(client.getPaneProcessInfo("w1:p3")).rejects.toThrow("another pane");
});

test("client validates JSON envelopes and passes unambiguous argv", async () => {
  const argv: string[][] = [];
  const client = new CliHerdrClient("herdr", async (_file, args) => { argv.push([...args]); return { stdout: JSON.stringify({ id: "request", result: { workspace: { workspace_id: "w1", label: "forge" } } }) }; });
  await expect(client.getWorkspace("w1; rm -rf /")).resolves.toMatchObject({ workspaceId: "w1" });
  expect(argv).toEqual([["workspace", "get", "w1; rm -rf /"]]);
});

test("pane layout and sizing methods validate geometry and pass exact argv", async () => {
  const argv: string[][] = [];
  const client = new CliHerdrClient("herdr", async (_file, args) => {
    argv.push([...args]);
    if (args[1] === "layout") return { stdout: JSON.stringify({ id: "layout", result: { layout: {
      workspace_id: "w1", tab_id: "w1:t1", zoomed: false, focused_pane_id: "w1:p1",
      area: { x: 0, y: 0, width: 120, height: 60 },
      panes: [{ pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 120, height: 60 } }],
      splits: [],
    } } }) };
    if (args[1] === "resize") return { stdout: JSON.stringify({ id: "resize", result: { resize: {} } }) };
    return { stdout: JSON.stringify({ id: "split", result: { pane: { pane_id: "w1:p2" } } }) };
  });

  await expect(client.getPaneLayout("w1:p1")).resolves.toMatchObject({ tabId: "w1:t1", area: { width: 120 }, panes: [{ paneId: "w1:p1" }] });
  await client.resizePane({ paneId: "w1:p1", direction: "down", amount: 1 / 6 });
  await client.splitPane({ paneId: "w1:p1", direction: "down", ratio: 0.5, cwd: "/repo", focus: false });

  expect(argv).toEqual([
    ["pane", "layout", "--pane", "w1:p1"],
    ["pane", "resize", "--pane", "w1:p1", "--direction", "down", "--amount", String(1 / 6)],
    ["pane", "split", "w1:p1", "--direction", "down", "--ratio", "0.5", "--cwd", "/repo", "--no-focus"],
  ]);
});

test("read-only viewport snapshots use native rows and the widest meaningful Unicode content", async () => {
  const ansi = `\x1b[31m${"x".repeat(90)}界\x1b[0m\r\nshort`;
  const argv: string[][] = [];
  const client = new CliHerdrClient("herdr", async (_file, args) => {
    argv.push([...args]);
    if (args[1] === "get") return { stdout: JSON.stringify({ id: "pane", result: { pane: { pane_id: "w1:p1", scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 49 } } } }) };
    if (args[1] === "layout") return { stdout: JSON.stringify({ id: "layout", result: { layout: {
      workspace_id: "w1", tab_id: "w1:t1", zoomed: false, focused_pane_id: "w1:p1",
      area: { x: 0, y: 0, width: 80, height: 12 }, panes: [], splits: [],
    } } }) };
    if (args[1] === "read") return { stdout: ansi };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  await expect(client.readPaneViewport("w1:p1")).resolves.toEqual({ ansi, cols: 92, rows: 49 });
  expect(argv).toEqual(expect.arrayContaining([
    ["pane", "get", "w1:p1"],
    ["pane", "layout", "--pane", "w1:p1"],
    ["pane", "read", "w1:p1", "--source", "visible", "--ansi"],
  ]));
});

test("read-only viewport snapshots do not pad native rows from stale layout height", async () => {
  const client = new CliHerdrClient("herdr", async (_file, args) => {
    if (args[1] === "get") return { stdout: JSON.stringify({ id: "pane", result: { pane: { pane_id: "w1:p1", scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 25 } } } }) };
    if (args[1] === "layout") return { stdout: JSON.stringify({ id: "layout", result: { layout: {
      workspace_id: "w1", tab_id: "w1:t1", zoomed: false, focused_pane_id: "w1:p1",
      area: { x: 0, y: 0, width: 120, height: 49 }, panes: [], splits: [],
    } } }) };
    if (args[1] === "read") return { stdout: "first\nsecond\nbottom" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  await expect(client.readPaneViewport("w1:p1")).resolves.toMatchObject({ rows: 25 });
});




test("client fails closed for malformed output and classifies syntax failures", async () => {
  const malformed = new CliHerdrClient("herdr", async () => ({ stdout: "not-json" }));
  await expect(malformed.listWorkspaces()).rejects.toMatchObject({ code: "invalid_response", retryable: false });
  const syntax = new CliHerdrClient("herdr", async () => { throw { code: 2, stderr: '{"error":{"code":"invalid_argument"}}' }; });
  await expect(syntax.listWorkspaces()).rejects.toEqual(expect.objectContaining<Partial<HerdrFailure>>({ code: "syntax", retryable: false }));
});

test.each(["stdout", "stderr"])("client recognizes missing Herdr resources from %s", async (stream) => {
  const client = new CliHerdrClient("herdr", async () => {
    throw {
      code: 1,
      [stream]: JSON.stringify({
        error: {
          code: "workspace_not_found",
          message: "workspace w2E not found",
        },
        id: "cli:workspace:get",
      }),
    };
  });

  await expect(client.getWorkspace("w2E")).resolves.toBeNull();
});


test("client marks only missing-resource lookups as expected non-zero probes", async () => {
  const options: Array<{ expectNonZero?: (result: CommandRunResult) => boolean }> = [];
  const client = new CliHerdrClient("herdr", async (_file, _args, runOptions) => {
    options.push(runOptions);
    throw { code: 1, stderr: '{"error":{"code":"pane_not_found"}}' };
  });

  await expect(client.getPane("missing-pane")).resolves.toBeNull();
  const matcher = options[0]?.expectNonZero;
  expect(matcher).toBeTypeOf("function");
  expect(matcher?.({ stdout: "", stderr: '{"error":{"code":"pane_not_found"}}' } as never)).toBe(true);
  expect(matcher?.({ stdout: "", stderr: '{"error":{"code":"permission_denied"}}' } as never)).toBe(false);
});

test("client preserves non-missing Herdr error details", async () => {
  const client = new CliHerdrClient("herdr", async () => {
    throw {
      code: 1,
      stdout: JSON.stringify({
        error: { code: "workspace_busy", message: "workspace w2E is busy" },
      }),
    };
  });

  await expect(client.listWorkspaces()).rejects.toMatchObject({
    code: "workspace_busy",
    message: "Herdr command failed: workspace w2E is busy",
  });
});

test("client preserves retryable Herdr timeout details", async () => {
  const client = new CliHerdrClient("herdr", async () => {
    throw {
      code: 1,
      stderr: JSON.stringify({
        error: { code: "timeout", message: "timed out waiting for output match" },
      }),
    };
  });

  await expect(client.getPane("w9:p2")).rejects.toMatchObject({
    code: "timeout",
    retryable: true,
    message: "Herdr command failed: timed out waiting for output match",
  });
});



test("pane run accepts an empty successful response", async () => {
  const client = new CliHerdrClient("herdr", async () => ({ stdout: "" }));

  await expect(client.runPaneCommand("w9:p2", "printf ready")).resolves.toBeUndefined();
});


test("pane run still classifies nonzero error envelopes", async () => {
  const client = new CliHerdrClient("herdr", async () => {
    throw {
      code: 1,
      stderr: JSON.stringify({
        error: { code: "workspace_not_found" },
      }),
    };
  });

  await expect(client.runPaneCommand("w9:p2", "printf ready")).rejects.toMatchObject({
    code: "workspace_not_found",
    message: "Herdr resource is unavailable",
  });
});

test("envelope-returning methods still reject empty successful responses", async () => {
  const client = new CliHerdrClient("herdr", async () => ({ stdout: " " }));

  await expect(client.listWorkspaces()).rejects.toMatchObject({
    code: "invalid_response",
    retryable: false,
  });
});





test("pane metadata reports use unambiguous argv for values and clears", async () => {
  const argv: string[][] = [];
  const client = new CliHerdrClient("herdr", async (_file, args) => {
    argv.push([...args]);
    return { stdout: "" };
  });

  await client.reportPaneMetadata({
    paneId: "w9:p2; echo unsafe",
    source: "forge",
    agent: "codex --verbose",
    appliesToSource: "herdr:codex",
    title: "Review = now; still one arg",
    displayAgent: "Codex worker",
    stateLabels: {
      working: "Reviewing=logs",
      blocked: "Needs input",
    },
    tokens: {
      forge_binding_id: "binding-1",
      forge_task_id: "task=1",
    },
    seq: 42,
    ttlMs: 60_000,
  });
  await client.reportPaneMetadata({
    paneId: "w9:p2",
    source: "forge",
    clearTitle: true,
    clearDisplayAgent: true,
    clearStateLabels: true,
    clearTokens: ["forge_binding_id", "forge_task_id"],
  });

  expect(argv).toEqual([
    [
      "pane",
      "report-metadata",
      "w9:p2; echo unsafe",
      "--source",
      "forge",
      "--agent",
      "codex --verbose",
      "--applies-to-source",
      "herdr:codex",
      "--title",
      "Review = now; still one arg",
      "--display-agent",
      "Codex worker",
      "--state-label",
      "working=Reviewing=logs",
      "--state-label",
      "blocked=Needs input",
      "--token",
      "forge_binding_id=binding-1",
      "--token",
      "forge_task_id=task=1",
      "--seq",
      "42",
      "--ttl-ms",
      "60000",
    ],
    [
      "pane",
      "report-metadata",
      "w9:p2",
      "--source",
      "forge",
      "--clear-title",
      "--clear-display-agent",
      "--clear-state-labels",
      "--clear-token",
      "forge_binding_id",
      "--clear-token",
      "forge_task_id",
    ],
  ]);
});
