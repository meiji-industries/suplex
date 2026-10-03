import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nativeBrowser } from "./helpers/native-browser.js";

const git = promisify(execFile);

test("projects desktop flow creates a project and opens its configuration", { timeout: 45_000 }, async () => {
  const github = createServer((request, response) => {
    const body = request.url === "/user" ? { login: "acme" }
      : request.url === "/user/orgs?per_page=100&page=1" ? []
      : request.url === "/graphql" ? { data: { repositoryOwner: { repositories: { nodes: [{ name: "suplex", defaultBranchRef: { name: "main" } }], pageInfo: { hasNextPage: false, endCursor: null } } } } }
      : request.url === "/repos/acme/suplex" ? { full_name: "acme/suplex", html_url: "https://github.com/acme/suplex" }
      : null;
    response.writeHead(body === null ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(accept => github.listen(0, "127.0.0.1", accept));
  const address = github.address();
  if (!address || typeof address === "string") throw new Error("Fake GitHub did not listen");
  const previousGithubApi = process.env.SUPLEX_TEST_GITHUB_API;
  process.env.SUPLEX_TEST_GITHUB_API = `http://127.0.0.1:${address.port}`;
  const fixture = await nativeBrowser();
  try {
    // An existing checkout exercises native project admission without network credentials.
    const checkout = join(fixture.directory, "repositories", "acme", "suplex");
    await mkdir(checkout, { recursive: true });
    await git("git", ["init", "--quiet", "--initial-branch=main", checkout]);
    await git("git", ["-C", checkout, "config", "user.name", "Suplex browser test"]);
    await git("git", ["-C", checkout, "config", "user.email", "suplex-browser@example.invalid"]);
    await git("git", ["-C", checkout, "commit", "--quiet", "--allow-empty", "-m", "Initial fixture"]);
    await git("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/acme/suplex.git"]);
    const bare = join(fixture.directory, "suplex-origin.git");
    await git("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
    await git("git", ["-C", checkout, "config", `url.file://${bare}.insteadOf`, "https://github.com/acme/suplex.git"]);
    await git("git", ["-C", checkout, "push", "--quiet", "origin", "main"]);

    const page = fixture.page;
    await page.goto(`${fixture.base}/projects?company=${fixture.company.id}`);
    await page.getByRole("heading", { name: "Projects", exact: true, level: 2 }).waitFor();
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    await page.getByLabel("Repository", { exact: true }).click();
    await page.getByRole("option", { name: "suplex", exact: true }).click();
    await page.getByRole("dialog", { name: "Add project", exact: true }).getByRole("button", { name: "Add project", exact: true }).click();
    await page.getByText("suplex", { exact: true }).waitFor();
    const project = page.getByRole("list", { name: "Projects", exact: true }).getByRole("listitem").filter({ has: page.getByText("suplex", { exact: true }) });
    await project.getByRole("link").click();
    await page.reload();
    expect(await page.getByLabel("Base branch").inputValue()).toBe("main");
    await page.getByLabel("Project name").fill("Suplex renamed");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByText("Saved", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Back to projects", exact: true }).click();
    await page.getByRole("heading", { name: "Projects", exact: true, level: 2 }).waitFor();
    await page.getByText("Suplex renamed", { exact: true }).waitFor();
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
    if (previousGithubApi === undefined) delete process.env.SUPLEX_TEST_GITHUB_API;
    else process.env.SUPLEX_TEST_GITHUB_API = previousGithubApi;
    await new Promise<void>(accept => github.close(() => accept()));
  }
});
