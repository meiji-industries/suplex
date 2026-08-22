import { expect, test } from "vitest";

import { createGithubReleasePort, ReleaseService, type GithubReleasePort } from "../src/github-release.js";

const sha = "a".repeat(40);

test("a verified remote task branch is not pushed again before publication", async () => {
  let pushes = 0;
  const github = {
    async checkAuthentication() {},
    async getRemoteRepository() { return "acme/forge"; },
    async inspectLocalRevision() { return { branch: "task/example", headSha: sha, treeSha: sha, clean: true }; },
    async getBranchHead() { return sha; },
    async pushNormal() { pushes += 1; },
  } as unknown as GithubReleasePort;

  await new ReleaseService(undefined as never, undefined as never, github).pushBranch({
    repository: "acme/forge", worktreePath: "/worktree", branchName: "task/example", commitSha: sha,
  });

  expect(pushes).toBe(0);
});

test("a draft PR 404 identifies the branch that must be pushed before retry", async () => {
  const github = createGithubReleasePort({
    runner: async () => {
      throw {
        stdout: JSON.stringify({ message: "Head sha can't be blank", documentation_url: "https://docs.github.com/rest/pulls/pulls#create-a-pull-request", status: 404 }),
        stderr: "",
      };
    },
  });

  await expect(github.createDraftPullRequest({ repository: "acme/forge", owner: "acme", headBranch: "task/example", baseBranch: "main", title: "Task", body: "Body" }))
    .rejects.toMatchObject({ summary: "Branch task/example is not on GitHub yet" });
});
