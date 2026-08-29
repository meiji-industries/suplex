import { expect, test } from "vitest";

import { CliHerdrClient, HerdrFailure } from "../src/herdr-client.js";

test("client validates JSON envelopes and passes unambiguous argv", async () => {
  const argv: string[][] = [];
  const client = new CliHerdrClient("herdr", async (_file, args) => { argv.push([...args]); return { stdout: JSON.stringify({ id: "request", result: { workspace: { workspace_id: "w1", label: "forge" } } }) }; });
  await expect(client.getWorkspace("w1; rm -rf /")).resolves.toMatchObject({ workspaceId: "w1" });
  expect(argv).toEqual([["workspace", "get", "w1; rm -rf /"]]);
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

test("client treats an inactive named agent as missing", async () => {
  const client = new CliHerdrClient("herdr", async () => {
    throw {
      code: 1,
      stderr: JSON.stringify({
        error: {
          code: "agent_name_not_found",
          message: "agent sampler-9-developer is not an active named agent",
        },
        id: "cli:agent:get",
      }),
    };
  });

  await expect(client.getAgent("sampler-9-developer")).resolves.toBeNull();
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

  await expect(client.waitPaneOutput("w9:p2", "nope")).rejects.toMatchObject({
    code: "timeout",
    retryable: true,
    message: "Herdr command failed: timed out waiting for output match",
  });
});

test("client reports a missing omp binary as an unavailable provider", async () => {
  const client = new CliHerdrClient("herdr", async () => {
    throw { code: 1, stderr: "omp: command not found" };
  });

  await expect(client.startAgent({ name: "forge-openrouter", paneId: "w1:p1", kind: "omp", args: [] })).rejects.toMatchObject({
    code: "provider-unavailable",
    retryable: false,
    message: "omp is not installed on the Forge host",
  });
});

test("pane run accepts an empty successful response", async () => {
  const client = new CliHerdrClient("herdr", async () => ({ stdout: "" }));

  await expect(client.runPaneCommand("w9:p2", "printf ready")).resolves.toBeUndefined();
});

test("pane read returns text from its successful JSON envelope", async () => {
  const client = new CliHerdrClient("herdr", async () => ({
    stdout: JSON.stringify({
      id: "cli:pane:read",
      result: { text: "recent pane output" },
    }),
  }));

  await expect(client.readPane("w9:p2")).resolves.toBe("recent pane output");
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

  await expect(client.sendKeys("forge-lead", ["ctrl+c"])).rejects.toMatchObject({
    code: "invalid_response",
    retryable: false,
  });
});

test("client excludes agent-less panes from agent listings", async () => {
  const client = new CliHerdrClient("herdr", async () => ({
    stdout: JSON.stringify({
      id: "cli:agent:list",
      result: {
        agents: [
          {
            name: null,
            pane_id: "w9:p2",
            tab_id: "w9:t1",
            workspace_id: "w9",
          },
          {
            name: "forge-lead",
            pane_id: "w2X:p1",
            tab_id: "w2X:t1",
            workspace_id: "w2X",
            agent_session: {
              kind: "id",
              value: "session-1",
              source: "herdr:codex",
              agent: "codex",
            },
            agent_status: "idle",
          },
          {
            name: null,
            pane_id: "w2X:p2",
            tab_id: "w2X:t1",
            workspace_id: "w2X",
          },
        ],
      },
    }),
  }));

  await expect(client.listAgents()).resolves.toEqual([
    expect.objectContaining({
      name: "forge-lead",
      paneId: "w2X:p1",
      tabId: "w2X:t1",
      workspaceId: "w2X",
      agentSession: "session-1",
      status: "idle",
    }),
  ]);
});

test("client accepts the legacy bare agent session form", async () => {
  const client = new CliHerdrClient("herdr", async () => ({
    stdout: JSON.stringify({
      id: "cli:agent:get",
      result: { agent: { name: "forge-lead", pane_id: "w2X:p1", agent_session: "session-1", status: "idle" } },
    }),
  }));

  await expect(client.getAgent("forge-lead")).resolves.toMatchObject({
    agentSession: "session-1",
    status: "idle",
  });
});

test("agent startup allows Codex interactive readiness under load", async () => {
  const argv: string[][] = [];
  const client = new CliHerdrClient("herdr", async (_file, args) => {
    argv.push([...args]);
    return {
      stdout: JSON.stringify({
        id: "cli:agent:start",
        result: {
          agent: { name: "task-lead", pane_id: "w2Y:p21", status: "idle" },
        },
      }),
    };
  });

  await client.startAgent({
    name: "task-lead",
    paneId: "w2Y:p21",
    kind: "codex",
    args: ["--model", "gpt-5"],
  });

  expect(argv).toEqual([
    [
      "agent",
      "start",
      "task-lead",
      "--kind",
      "codex",
      "--pane",
      "w2Y:p21",
      "--timeout",
      "120000",
      "--",
      "--model",
      "gpt-5",
    ],
  ]);
});
