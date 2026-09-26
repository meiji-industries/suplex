// Inspect a complete published-base-to-head patch through the Rust Root MCP.
import { equal, match, notEqual, ok } from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { nativeFixture } from "../helpers/native-browser.js";
import { nativeRootBridge } from "../helpers/native-root-bridge.js";
import { initializeAndList, runMcpProcess } from "../helpers/mcp-process.js";

const execute = promisify(execFile);
const fixture = await nativeFixture();
const repository = fixture.project.repositoryPath;
const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-C", cwd, ...args])).stdout.trim();
let publishedSha: string | null = null;
const api = createServer((request, response) => {
  const body = request.url === "/repos/owner/repo/branches/main" && publishedSha ? { commit: { sha: publishedSha } } : null;
  response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(body ?? { message: "Not Found" }));
});
await new Promise<void>(accept => api.listen(0, "127.0.0.1", accept));
const address = api.address();
if (!address || typeof address === "string") throw new Error("Fake GitHub API did not listen");
const githubApi = `http://127.0.0.1:${address.port}`;
try {
  await writeFile(join(repository, "plain.txt"), "before\n");
  await writeFile(join(repository, "rename.txt"), "renamed content\n");
  await writeFile(join(repository, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(repository, "nonewline.txt"), "before");
  await writeFile(join(repository, "mode.sh"), "#!/bin/sh\necho hi\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "--quiet", "-m", "Base");
  publishedSha = await git(repository, "rev-parse", "HEAD");
  await git(repository, "push", "--quiet", "origin", "main");
  const task = await fixture.createTask({ title: "Inspect complete delivery patch", description: "Review real Git changes", idempotencyKey: "delivery-inspection", startImmediately: false, deliveryTarget: "local_worktree" });
  const { server } = await nativeRootBridge(fixture, task.id);
  const branch = task.configuration.branch;
  const worktree = join(fixture.project.worktreeRoot, task.id);
  await mkdir(fixture.project.worktreeRoot, { recursive: true });
  await git(repository, "worktree", "add", "--quiet", "-b", branch, worktree, publishedSha);
  await writeFile(join(worktree, "plain.txt"), "after\n");
  await rename(join(worktree, "rename.txt"), join(worktree, "moved.txt"));
  await writeFile(join(worktree, "binary.bin"), Buffer.from([0, 1, 2, 254]));
  await writeFile(join(worktree, "nonewline.txt"), "after");
  await writeFile(join(worktree, "password=fixture.txt"), "Synthetic gho_ABCDEFGH and égho_ABCDEFGH\n");
  await chmod(join(worktree, "mode.sh"), 0o755);
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "--quiet", "-m", "Change source");
  await writeFile(join(worktree, "second.txt"), "Second commit\n");
  await git(worktree, "add", "second.txt");
  await git(worktree, "commit", "--quiet", "-m", "Add second change");
  const headSha = await git(worktree, "rev-parse", "HEAD");
  fixture.database.prepare("UPDATE suplex_task_controls SET worktree_json = ? WHERE task_id = ?")
    .run(JSON.stringify({ path: worktree, branch, baseSha: "0".repeat(40), headSha: "f".repeat(40), dirty: true }), task.id);
  const call = async () => {
    const result = await runMcpProcess(server, { ...process.env, ...server.environment, SUPLEX_TEST_GITHUB_API: githubApi }, [
      ...initializeAndList,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "suplex_root", arguments: { kind: "request_delivery", operation: "inspect_delivery_diff" } } },
    ]);
    const response = result.responses.find(value => typeof value === "object" && value !== null && "id" in value && value.id === 3) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: unknown } } | undefined;
    return { response: response?.result, stderr: result.stderr };
  };
  const inspected = await call();
  equal(inspected.response?.isError, false, `${JSON.stringify(inspected.response)}; ${inspected.stderr}`);
  const diff = inspected.response!.structuredContent!;
  equal(diff.baseSha, publishedSha);
  equal(diff.headSha, headSha);
  ok((diff.files as unknown[]).length >= 5);
  ok((diff.commits as unknown[]).length >= 2);
  match(JSON.stringify(diff), /plain.txt|moved.txt/);
  notEqual(diff.patchDigest, null);
  equal(await readFile(join(worktree, "plain.txt"), "utf8"), "after\n");
  const saved = JSON.parse((fixture.database.prepare("SELECT worktree_json FROM suplex_task_controls WHERE task_id = ?").get(task.id) as { worktree_json: string }).worktree_json) as { headSha: string };
  equal(saved.headSha, "f".repeat(40), "inspection must not replace saved task intent");
  publishedSha = null;
  const missing = await call();
  equal(missing.response?.isError, true);
  console.log("Rust Root MCP inspects live Git patch, including renamed and binary files, without rewriting saved task intent.");
} finally {
  await fixture.close();
  await new Promise<void>(accept => api.close(() => accept()));
}
