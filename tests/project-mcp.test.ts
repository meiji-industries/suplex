import { expect, test } from "vitest";
import { ProjectMcpSchema, projectMcpServers, projectMcpTools } from "../src/runtimes/project-mcp.js";
import { claudeArguments } from "../src/runtimes/claude-code/task-runtime.js";
import { claudeEnvironment } from "../src/runtimes/claude-code/environment.js";
import { createProviderReadinessCheck } from "../src/profiles/provider-readiness.js";
import type { TaskScope } from "../src/runtimes/task-harness.js";

const servers = ProjectMcpSchema.parse([{ name: "context7", transport: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "CONTEXT7_TOKEN" } }, grants: { root: ["query_docs"], advisor: [], worker: ["query_docs", "resolve_library_id"] } }]);

test("MCP grants are exact, role scoped and cannot replace Suplex bridges", () => {
  expect(projectMcpTools(servers, "root")).toEqual(["mcp__context7__query_docs"]);
  expect(projectMcpServers(servers, "advisor", {})).toEqual({});
  expect(projectMcpServers(servers, "root", { CONTEXT7_TOKEN: "fixture" })).toEqual({ context7: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "fixture" } } });
  expect(() => projectMcpServers(servers, "root", {})).toThrow("CONTEXT7_TOKEN");
  expect(ProjectMcpSchema.safeParse([{ ...servers[0], name: "suplex_root" }]).success).toBe(false);
  expect(ProjectMcpSchema.safeParse([{ ...servers[0], grants: { root: ["*"], advisor: [], worker: [] } }]).success).toBe(false);
});

test("MCP worker grants never run with permission bypass", () => {
  const scope: TaskScope = { id: "s", taskId: "t", directory: "/repo", role: "worker", workerMode: "planned", purpose: "implementation", workflow: "standard", evidenceRoot: null, profile: { providerID: "claude-code", modelID: "haiku", reasoningEffort: "low", serviceTier: "default", instanceHomeDirectory: "/dedicated" }, projectMcp: servers };
  const args = claudeArguments({ scope, sessionID: "session", resume: true, print: true, runtimeDirectory: "/runtime" });
  expect(args).not.toContain("--dangerously-skip-permissions");
  expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "/runtime/mcp.json", "--permission-mode", "dontAsk", "--setting-sources", ""]));
  expect(args[args.indexOf("--allowedTools") + 1]).toContain("mcp__context7__query_docs");
  expect(args[args.indexOf("--allowedTools") + 1]).not.toContain("mcp__context7__*");
});

test("dedicated auth removes inherited tokens and cloud routing in readiness and launch", async () => {
  const inherited = { PATH: "/bin", HOME: "/home", ANTHROPIC_API_KEY: "wrong", ANTHROPIC_BASE_URL: "https://wrong", ANTHROPIC_PROFILE: "wrong", CLAUDE_CODE_OAUTH_TOKEN: "wrong", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CONFIG_DIR: "/wrong" };
  const expected = { PATH: "/bin", HOME: "/home", CLAUDE_CONFIG_DIR: "/dedicated", ANTHROPIC_CONFIG_DIR: "/dedicated/anthropic" };
  expect(claudeEnvironment("/dedicated", inherited)).toEqual(expected);
  expect(claudeEnvironment(null, inherited)).toEqual(inherited);
  let captured: NodeJS.ProcessEnv | undefined;
  const check = await createProviderReadinessCheck("claude-code", { env: { ...inherited, CLAUDE_CONFIG_DIR: "/dedicated" }, resolveExecutable: async () => "/fake/claude", runCommand: async (_command, args, options) => {
    captured = options.env;
    expect(args).toEqual(["auth", "status", "--json", "--setting-sources", ""]);
    return { stdout: '{"loggedIn":false}', stderr: "", exitCode: 1, timedOut: false };
  } })();
  expect(captured).toEqual(expected);
  expect(check.status).toBe("unhealthy");
});
