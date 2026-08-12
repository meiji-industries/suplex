import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createGithubAdapter } from "../src/github.js";

test("GitHub mutation observation normalizes branch and pull-request pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-gh-observation-"));
  const command = join(root, "gh-fixture.mjs");
  await writeFile(command, `#!/usr/bin/env node\nconst args = process.argv.slice(2).join(" ");\nif (args.includes("git/refs/heads")) console.log(JSON.stringify([[{ref:"refs/heads/z",object:{sha:"2"}},{ref:"refs/heads/a",object:{sha:"1"}}]]));\nelse console.log(JSON.stringify([[{number:2,state:"open",draft:true,head:{ref:"work/issue/t",sha:"2"},base:{ref:"main"},updated_at:"2026-08-11T00:00:00Z"}]]));\n`, { encoding: "utf8", mode: 0o700 });
  await chmod(command, 0o700);
  try {
    const observation = await createGithubAdapter(command).observeMutationSurface!({ cwd: root, nameWithOwner: "acme/forge" });
    expect(observation.branches).toEqual([{ name: "a", sha: "1" }, { name: "z", sha: "2" }]);
    expect(observation.pullRequests[0]).toMatchObject({ number: 2, headRef: "work/issue/t", baseRef: "main" });
    expect(observation.sha256).toMatch(/^[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
