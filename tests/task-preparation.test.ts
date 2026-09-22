import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProjectExecutionSchema } from "../src/projects/execution-configuration.js";
import { prepareProjectWorkspace, setupEnvironment, taskPreparationDirectory } from "../src/tasks/preparation.js";
import { excludeEnvironmentKeys, projectCredentialEnvironmentKeys } from "../src/runtimes/project-environment.js";
import { ProjectMcpSchema, projectMcpServers } from "../src/runtimes/project-mcp.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("preparation preserves worktree files, copies skills outside Git, and reruns idempotent setup without receipt gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-preparation-"));
  directories.push(root);
  const worktree = join(root, "worktree");
  const skills = join(root, "skills");
  await Promise.all([mkdir(worktree), mkdir(skills)]);
  await writeFile(join(worktree, "CLAUDE.md"), "user-owned");
  await writeFile(join(skills, "SKILL.md"), "Use this skill");
  const input = { databasePath: join(root, "suplex.sqlite"), taskId: "task", directory: worktree, execution: ProjectExecutionSchema.parse({ instructions: "Keep draft delivery", skillDirectories: [skills], environment: { PREPARATION_SENTINEL: "ok" } }), setupCommand: 'test "$PREPARATION_SENTINEL" = ok && (test -f prepared || printf ready > prepared)' };
  await prepareProjectWorkspace(input);
  const contextPath = join(taskPreparationDirectory(input.databasePath, input.taskId), "context.md");
  expect(await readFile(contextPath, "utf8")).toContain("Configured setup exited 0");
  await rm(contextPath);
  await prepareProjectWorkspace(input);
  const context = await readFile(contextPath, "utf8");
  expect(context).toContain("Keep draft delivery");
  expect(context).toContain("delivery-evidence.json");
  expect(context).toContain("/runtime/task-preparation/task/skills/");
  expect(await readFile(join(worktree, "CLAUDE.md"), "utf8")).toBe("user-owned");
  expect(await readFile(join(worktree, "prepared"), "utf8")).toBe("ready");
  await prepareProjectWorkspace({ ...input, setupCommand: "printf fixture-failure; exit 7" });
  expect(await readFile(contextPath, "utf8")).toContain("Delegate a bounded repair");
  expect(await readFile(contextPath, "utf8")).toContain("fixture-failure");
});

test("setup only inherits non-secret tooling environment", () => {
  expect(setupEnvironment({ PROJECT_MODE: "test" }, { HOME: "/home", PATH: "/bin", GH_TOKEN: "secret", ANTHROPIC_BASE_URL: "wrong", AWS_PROFILE: "private", SUPLEX_ROOT_TOKEN: "secret", PASSWORD: "secret" })).toEqual({ HOME: "/home", PATH: "/bin", PROJECT_MODE: "test" });
});

test("opaque integration credential references are excluded from project subprocesses", () => {
  const keys = projectCredentialEnvironmentKeys({ repository: { kind: "bitbucket", tokenEnvironment: "MY_VALUE", usernameEnvironment: "MY_NAME" }, tracker: { kind: "jira", site: "https://example.atlassian.net", project: "APP", emailEnvironment: "ACCOUNT", tokenEnvironment: "OTHER_VALUE" } });
  expect(excludeEnvironmentKeys({ PATH: "/bin", MY_VALUE: "secret", MY_NAME: "secret", ACCOUNT: "secret", OTHER_VALUE: "secret" }, keys)).toEqual({ PATH: "/bin" });
});

test("MCP credential references are removed from general environments regardless of role grants", () => {
  const mcp = ProjectMcpSchema.parse([
    { name: "lookup", transport: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "C7_ACCESS" } }, grants: { root: ["read"], advisor: [], worker: [] } },
    { name: "local", transport: { type: "stdio", command: "server", env: { KEY: "OPAQUE_VALUE" } }, grants: { root: [], advisor: [], worker: ["read"] } },
  ]);
  const environment = { PATH: "/bin", C7_ACCESS: "private", OPAQUE_VALUE: "private" };
  const keys = projectCredentialEnvironmentKeys(undefined, mcp);
  expect(excludeEnvironmentKeys(environment, keys)).toEqual({ PATH: "/bin" });
  expect(excludeEnvironmentKeys(setupEnvironment({}, environment), keys)).toEqual({ PATH: "/bin" });
  expect(projectMcpServers(mcp, "root", environment)).toEqual({ lookup: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "private" } } });
  expect(projectMcpServers(mcp, "advisor", environment)).toEqual({});
});
