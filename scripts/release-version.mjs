import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const files = ["package.json", "desktop/package.json"];
const rustFiles = ["rust/Cargo.toml", "rust/Cargo.lock"];
const packages = await Promise.all(files.map(async (file) => ({ file, value: JSON.parse(await readFile(file, "utf8")) })));
const rustPackages = await Promise.all(rustFiles.map(async (file) => ({ file, text: await readFile(file, "utf8") })));
const current = packages[0].value.version;
if (!packages.every(({ value }) => value.version === current) || !rustPackages.every(({ text }) => text.includes(`name = "suplex"\nversion = "${current}"`))) {
  throw new Error("Desktop, frontend, and native versions must match before release.");
}

const mode = process.argv[2];
if (mode !== "bump" && mode !== "check-tag") throw new Error("Expected bump or check-tag.");
const tags = new Set([
  ...git("tag", "--list").trim().split("\n"),
  ...git("ls-remote", "--tags", "--refs", "origin").trim().split("\n").map(line => line.split("\trefs/tags/")[1]),
]);

if (mode === "check-tag") {
  if (tags.has(`v${current}`)) throw new Error(`Tag v${current} already exists. Choose a new release version before building.`);
} else {
  const parse = version => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  let latest = parse(current);
  if (!latest) throw new Error(`Expected a semantic version, got ${current}.`);
  for (const tag of tags) {
    const version = parse(tag?.replace(/^v/, ""));
    if (!version) continue;
    const difference = version.map((part, index) => part - latest[index]).find(part => part !== 0);
    if (difference > 0) latest = version;
  }
  const [major, minor, patch] = latest;
  const next = process.env.RELEASE_BUMP === "major" ? `${major + 1}.0.0`
    : process.env.RELEASE_BUMP === "minor" ? `${major}.${minor + 1}.0`
    : process.env.RELEASE_BUMP === "patch" ? `${major}.${minor}.${patch + 1}`
    : (() => { throw new Error("RELEASE_BUMP must be major, minor, or patch."); })();
  await Promise.all(packages.map(({ file, value }) => writeFile(file, `${JSON.stringify({ ...value, version: next }, null, 2)}\n`)));
  await Promise.all(rustPackages.map(({ file, text }) => writeFile(file, text.replace(`name = "suplex"\nversion = "${current}"`, `name = "suplex"\nversion = "${next}"`))));
  console.log(`${current} -> ${next}`);
}
