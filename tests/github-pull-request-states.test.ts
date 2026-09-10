import { expect, test } from "vitest";
import { createGithubReleasePort } from "../src/integrations/github/delivery.js";

test("reads 51 distinct pull requests across repositories in two requests", async () => {
  const queries: string[] = [];
  const port = createGithubReleasePort({ runner: async ({ args }) => {
    const query = args.find(arg => arg.startsWith("query="))!;
    queries.push(query);
    const matches = [...query.matchAll(/p(\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)];
    return { stdout: JSON.stringify({ data: Object.fromEntries(matches.map(([, index, owner, name, number]) => [`p${index}`, { pullRequest: { number: Number(number), url: `https://github.com/${owner}/${name}/pull/${number}`, headRefOid: "a".repeat(40), state: "MERGED", mergedAt: "2026-09-10T02:32:47Z" } }])) }), stderr: "" };
  } });
  const inputs = Array.from({ length: 51 }, (_, i) => ({ repository: i % 2 ? "owner/one" : "owner/two", number: i + 1 }));
  const result = await port.getPullRequestStates([...inputs, { ...inputs[0]!, repository: "OWNER/TWO" }]);
  expect(queries).toHaveLength(2);
  expect(result).toHaveLength(51);
  expect(result[0]).toMatchObject({ repository: "owner/two", number: 1, state: "merged" });
  await expect(port.getPullRequestStates([])).resolves.toEqual([]);
  expect(queries).toHaveLength(2);
});

test("keeps available observations when GitHub reports partial GraphQL errors", async () => {
  const port = createGithubReleasePort({ runner: async () => {
    throw Object.assign(new Error("GraphQL errors"), { stdout: JSON.stringify({ data: { p0: null, p1: { pullRequest: { number: 2, url: "https://github.com/owner/repo/pull/2", headRefOid: "a".repeat(40), state: "OPEN", mergedAt: null } } }, errors: [{ message: "Could not resolve repository" }] }), stderr: "gh: Could not resolve repository" });
  } });
  await expect(port.getPullRequestStates([{ repository: "missing/repo", number: 1 }, { repository: "owner/repo", number: 2 }])).resolves.toMatchObject([{ number: 2, state: "open" }]);
});
