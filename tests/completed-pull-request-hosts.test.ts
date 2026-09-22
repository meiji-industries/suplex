import { afterEach, expect, test } from "vitest";
import { CompletedPullRequests } from "../src/delivery/completed-pull-requests.js";
import { cleanupRootControllerFixtures, fixture } from "./helpers/root-controller-fixture.js";
import { insertNativeTaskRow } from "./helpers/native-task-row.js";
import { hasPullRequestOwner } from "../src/delivery/pull-request-ownership.js";

afterEach(cleanupRootControllerFixtures);

test("completed observations keep identical repository coordinates on distinct hosts separate", async () => {
  const f = await fixture();
  const original = f.store.get("task");
  f.database.authTransaction(db => {
    insertNativeTaskRow(db, { taskId: "bitbucket-task" });
    db.prepare("UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.integration', json(?)) WHERE id = 'bitbucket-task'").run(JSON.stringify({ repository: { kind: "bitbucket", tokenEnvironment: "BB_TOKEN" }, tracker: null }));
  });
  f.store.create({ taskId: "bitbucket-task", startImmediately: true, objective: "Client task", deliveryTarget: "pull_request_draft", deliveryIntent: original.deliveryIntent, rootProfile: original.rootProfile, workerProfile: original.workerProfile });
  f.store.admitQueued(["bitbucket-task"]);
  const common = { repository: "owner/repo", number: 42, headSha: "a".repeat(40), state: "open", mergedAt: null };
  const github = { ...common, url: "https://github.com/owner/repo/pull/42" };
  const bitbucket = { ...common, url: "https://bitbucket.org/owner/repo/pull-requests/42" };
  f.store.setPullRequest("task", github);
  expect(f.database.authQuery(db => hasPullRequestOwner(db, { taskId: "bitbucket-task", repository: "owner/repo", number: 42 }))).toBe(false);
  expect(f.database.authQuery(db => hasPullRequestOwner(db, { repository: "owner/repo", number: 42 }))).toBe(true);
  f.store.setPullRequest("bitbucket-task", bitbucket);
  for (const id of ["task", "bitbucket-task"]) f.store.markDelivered(id);
  let githubCalls = 0; let bitbucketCalls = 0;
  const refresh = new CompletedPullRequests(f.database, { getPullRequestStates: async inputs => { githubCalls++; expect(inputs).toEqual([{ repository: "owner/repo", number: 42 }]); return [{ ...github, state: "merged" }]; } }, connection => {
    expect(connection.tokenEnvironment).toBe("BB_TOKEN");
    return { getPullRequestStates: async inputs => { bitbucketCalls++; expect(inputs).toEqual([{ repository: "owner/repo", number: 42 }]); return [{ ...bitbucket, state: "closed" }]; } };
  });
  await refresh.refresh();
  expect(githubCalls).toBe(1); expect(bitbucketCalls).toBe(1);
  expect(f.store.get("task").pullRequest).toMatchObject({ state: "merged", url: github.url });
  expect(f.store.get("bitbucket-task").pullRequest).toMatchObject({ state: "closed", url: bitbucket.url });
});
