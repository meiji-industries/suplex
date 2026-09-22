import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createTestDatabase } from "./helpers/test-database.js";
import { insertNativeTaskRow } from "./helpers/native-task-row.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";
import { taskEvidenceRoot } from "../src/coordination/workflow-evidence.js";
import { IssueEvidence, renderDeliveryEvidence, DeliveryEvidenceSchema } from "../src/delivery/issue-evidence.js";
import { IssueTracker } from "../src/integrations/issue-tracker.js";
import { createGithubReleasePort, type GithubPullRequest } from "../src/integrations/github/delivery.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });
const headSha = "a".repeat(40);
const issue = { kind: "jira", site: "https://test.atlassian.net", id: "42", key: "APP-42", title: "Fix", url: "https://test.atlassian.net/browse/APP-42" };
const evidence = DeliveryEvidenceSchema.parse({ headSha, summary: "Fix the button", before: [{ command: "test", output: "failed\n```" }], after: [{ command: "test", output: "passed" }], howToVerify: ["Click the button"] });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "forge-issue-evidence-"));
  const database = createTestDatabase(join(directory, "forge.sqlite"));
  cleanup.push(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const stamp = new Date().toISOString();
  database.authTransaction(db => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', '', '', ?, ?)").run(directory, directory, stamp, stamp);
    insertNativeTaskRow(db, { directory });
    db.prepare("UPDATE forge_tasks SET issue_json = ?, configuration_json = json_set(configuration_json, '$.integration', json(?)) WHERE id = 'task'").run(JSON.stringify(issue), JSON.stringify({ repository: { kind: "github" }, tracker: { kind: "jira", site: issue.site, project: "APP", emailEnvironment: "TEST_EMAIL", tokenEnvironment: "TEST_TOKEN" } }));
  });
  const store = new TaskControlStore(database);
  const profile = { profileId: "profile", provider: "codex" as const, model: "gpt-5.6-sol", reasoningLevel: "medium" as const, serviceTier: "default" as const };
  store.create({ startImmediately: true, taskId: "task", objective: "Fix", deliveryTarget: "pull_request_draft", deliveryIntent: { repository: "owner/repo", headBranch: "task", baseBranch: "main", baselineSha: headSha, pullRequestNumber: null }, rootProfile: profile, workerProfile: profile });
  store.admitQueued(["task"]);
  store.updateWorkflowState("task", state => ({ ...state, acceptedDelivery: { baseSha: headSha, headSha, files: [], commits: [] } }));
  store.setWorktree("task", { path: directory, branch: "task", headSha, baseSha: headSha, dirty: false });
  const generated = join(taskEvidenceRoot(database.filename()), "task", "generated");
  await mkdir(generated, { recursive: true });
  await writeFile(join(generated, "delivery-evidence.json"), JSON.stringify(evidence));
  let pull: GithubPullRequest = { repository: "owner/repo", number: 7, url: "https://github.com/owner/repo/pull/7", headBranch: "task", baseBranch: "main", headSha, baseSha: headSha, isDraft: true, state: "open", mergedAt: null, title: "Fix", body: "Reviewed change" };
  const update = vi.fn(async (input: { title: string; body: string }) => { pull = { ...pull, ...input }; return pull; });
  const port = { ...createGithubReleasePort(), inspectLocalRevision: vi.fn(async () => ({ branch: "task", headSha, treeSha: headSha, clean: true })), getPullRequest: async () => pull, updateDraftPullRequest: update };
  return { database, store, generated, port, update, service: new IssueEvidence(store) };
}

test("retains raw evidence and retries the captured issue after a lost response, without changing the PR again", async () => {
  const value = await fixture();
  const remote = new Map<string, string>();
  let fail = true;
  const publish = vi.spyOn(IssueTracker.prototype, "publish").mockImplementation(async (destination, task, body) => {
    remote.set(`${destination.id}:${task}`, body);
    if (fail) { fail = false; throw new Error("lost response"); }
    return "comment-7";
  });
  await expect(value.service.complete("task", 7, headSha, value.port)).rejects.toThrow("lost response");
  value.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET issue_json = ? WHERE id = 'task'").run(JSON.stringify({ ...issue, id: "99", key: "APP-99" })));
  await rm(value.generated, { recursive: true });
  await value.service.complete("task", 7, headSha, value.port);
  expect(remote.size).toBe(1);
  expect(publish.mock.calls.every(call => call[0].id === "42")).toBe(true);
  expect(value.update).toHaveBeenCalledTimes(1);
  expect(value.database.authQuery(db => db.prepare("SELECT COUNT(*) AS n FROM forge_artifacts WHERE task_id = 'task'").get())).toEqual({ n: 1 });
  await value.service.complete("task", 7, headSha, value.port);
  expect(publish).toHaveBeenCalledTimes(3);
  expect(publish.mock.calls[2]?.[4]).toBe("comment-7");
});

test("missing local observation does not affect retained evidence, while a new symlink is rejected", async () => {
  const value = await fixture();
  vi.spyOn(IssueTracker.prototype, "publish").mockResolvedValue("comment-1");
  await rm(join(value.generated, "delivery-evidence.json"));
  const outside = join(value.generated, "..", "outside.json");
  await writeFile(outside, JSON.stringify(evidence));
  await symlink(outside, join(value.generated, "delivery-evidence.json"));
  await expect(value.service.complete("task", 7, headSha, value.port)).rejects.toThrow();
  expect(value.update).not.toHaveBeenCalled();
});

test("raw command output cannot terminate its markdown fence", () => {
  expect(renderDeliveryEvidence(evidence, [])).toContain("````text\nfailed\n```\n````");
});

test("cancellation during source inspection prevents evidence writes", async () => {
  const value = await fixture();
  value.port.inspectLocalRevision.mockImplementation(async () => {
    value.store.cancel("task");
    return { branch: "task", headSha, treeSha: headSha, clean: true };
  });
  await expect(value.service.complete("task", 7, headSha, value.port)).rejects.toThrow("authorization changed");
  expect(value.update).not.toHaveBeenCalled();
});

test("a changed source prevents evidence writes", async () => {
  const value = await fixture();
  value.port.inspectLocalRevision.mockResolvedValue({ branch: "task", headSha: "b".repeat(40), treeSha: headSha, clean: true });
  await expect(value.service.complete("task", 7, headSha, value.port)).rejects.toThrow("clean task branch");
  expect(value.update).not.toHaveBeenCalled();
});

test("evidence retries preserve human text after the owned block", async () => {
  const value = await fixture();
  vi.spyOn(IssueTracker.prototype, "publish").mockResolvedValue("comment-1");
  await value.service.complete("task", 7, headSha, value.port);
  const pull = await value.port.getPullRequest();
  await value.update({ title: "Fix", body: `${pull.body}\n\nHuman follow-up` });
  value.update.mockClear();
  await value.service.complete("task", 7, headSha, value.port);
  expect((await value.port.getPullRequest()).body).toMatch(/Human follow-up$/);
  expect(value.update).not.toHaveBeenCalled();
});

test("publication preserves title and body edits made during local source inspection", async () => {
  const value = await fixture();
  vi.spyOn(IssueTracker.prototype, "publish").mockResolvedValue("comment-1");
  let edited = false;
  value.port.inspectLocalRevision.mockImplementation(async () => {
    if (!edited) {
      edited = true;
      await value.update({ title: "Human title", body: "Human body added during inspection" });
      value.update.mockClear();
    }
    return { branch: "task", headSha, treeSha: headSha, clean: true };
  });
  await value.service.complete("task", 7, headSha, value.port);
  const pull = await value.port.getPullRequest();
  expect(pull.title).toBe("Human title");
  expect(pull.body).toContain("Human body added during inspection");
  expect(value.update).toHaveBeenCalledTimes(1);
});
