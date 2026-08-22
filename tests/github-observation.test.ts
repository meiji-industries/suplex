import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createGithubAdapter } from "../src/github.js";
import { jsonRequired } from "../src/task-utils.js";

test("GitHub mutation observation normalizes branch and pull-request pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-gh-observation-"));
  const command = join(root, "gh-fixture.mjs");
  const argumentsPath = join(root, "arguments.json");
  await writeFile(command, `#!/usr/bin/env node\nimport { appendFile } from "node:fs/promises";\nconst args = process.argv.slice(2);\nawait appendFile(${JSON.stringify(argumentsPath)}, JSON.stringify(args) + "\\n");\nif (args.some((arg) => arg.includes("git/refs/heads"))) console.log(JSON.stringify([[{ref:"refs/heads/z",object:{sha:"2"}},{ref:"refs/heads/a",object:{sha:"1"}}]]));\nelse console.log(JSON.stringify([[{number:2,state:"open",draft:true,head:{ref:"work/issue/t",sha:"2"},base:{ref:"main"},updated_at:"2026-08-11T00:00:00Z"}]]));\n`, { encoding: "utf8", mode: 0o700 });
  await chmod(command, 0o700);
  try {
    const observation = await createGithubAdapter(command).observeMutationSurface!({ cwd: root, nameWithOwner: "acme/forge" });
    expect(observation.branches).toEqual([{ name: "a", sha: "1" }, { name: "z", sha: "2" }]);
    expect(observation.pullRequests[0]).toMatchObject({ number: 2, headRef: "work/issue/t", baseRef: "main" });
    expect(observation.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await readFile(argumentsPath, "utf8")).trim().split("\n").map((line) => jsonRequired(line))).toEqual(expect.arrayContaining([
      ["api", "--paginate", "--slurp", "--jq", "map({ref, object: {sha: .object.sha}})", "-H", "Accept: application/vnd.github+json", "repos/acme/forge/git/refs/heads?per_page=100"],
      ["api", "--paginate", "--slurp", "--jq", "map({number, state, draft, head: {ref: .head.ref, sha: .head.sha}, base: {ref: .base.ref}, updated_at})", "-H", "Accept: application/vnd.github+json", "repos/acme/forge/pulls?state=open&per_page=100"],
    ]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("GitHub mutation observation handles 500 projected open pull requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-gh-observation-"));
  const command = join(root, "gh-fixture.mjs");
  await writeFile(command, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args.some((arg) => arg.includes("git/refs/heads"))) console.log(JSON.stringify([[{ref:"refs/heads/main",object:{sha:"main"}}]]));\nelse console.log(JSON.stringify([Array.from({length:500}, (_, index) => ({number:index + 1,state:"open",draft:false,head:{ref:\`issue/\${index + 1}\`,sha:String(index + 1)},base:{ref:"main"},updated_at:"2026-08-11T00:00:00Z"}))]));\n`, { encoding: "utf8", mode: 0o700 });
  await chmod(command, 0o700);
  try {
    const observation = await createGithubAdapter(command).observeMutationSurface!({ cwd: root, nameWithOwner: "acme/forge" });
    expect(observation.pullRequests).toHaveLength(500);
    expect(observation.pullRequests[499]).toMatchObject({ number: 500, headRef: "issue/500" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
