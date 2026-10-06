import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("./release-version.mjs", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "suplex-release-"));
const checkout = join(scratch, "checkout");
const remote = join(scratch, "remote.git");
const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const files = ["package.json", "desktop/package.json", "mobile/package.json", "rust/Cargo.toml", "rust/Cargo.lock", "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/Cargo.lock"];
const contents = () => files.map(file => readFileSync(join(checkout, file), "utf8"));
const crateName = file => file.startsWith("desktop/src-tauri/") ? "suplex-desktop" : "suplex";
const setVersion = version => {
  for (const file of files) writeFileSync(join(checkout, file), file.endsWith(".json")
    ? `${JSON.stringify({ name: "suplex", version })}\n`
    : `name = "${crateName(file)}"\nversion = "${version}"\n`);
};
const run = (mode, bump = "minor") => spawnSync(process.execPath, [script, mode], {
  cwd: checkout, encoding: "utf8", env: { ...process.env, RELEASE_BUMP: bump },
});
const bumpTo = (bump, expected) => {
  const result = run("bump", bump);
  assert.equal(result.status, 0, result.stderr);
  for (const text of contents()) assert.ok(text.includes(expected), text);
};
const failsWithoutWrites = (mode, bump, message) => {
  const before = contents();
  const result = run(mode, bump);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
  assert.deepEqual(contents(), before);
};

try {
  mkdirSync(join(checkout, "desktop", "src-tauri"), { recursive: true });
  mkdirSync(join(checkout, "mobile"));
  mkdirSync(join(checkout, "rust"));
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.com");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  setVersion("0.6.1");
  git("add", ".");
  git("commit", "-m", "initial");
  git("tag", "-a", "v0.7.0", "-m", "remote release");
  git("push", "origin", "main", "v0.7.0");
  git("tag", "-d", "v0.7.0");
  bumpTo("minor", "0.8.0");
  git("tag", "v0.9.0");
  git("tag", "v0.10.0");
  git("tag", "v99.0.0-beta.1");
  bumpTo("patch", "0.10.1");
  bumpTo("major", "1.0.0");
  bumpTo("patch", "1.0.1");
  failsWithoutWrites("bump", "invalid", /RELEASE_BUMP must/);
  setVersion("0.7.0");
  failsWithoutWrites("check-tag", "minor", /Tag v0.7.0 already exists/);
  setVersion("0.10.0");
  failsWithoutWrites("check-tag", "minor", /Tag v0.10.0 already exists/);
  setVersion("1.0.1");
  assert.equal(run("check-tag").status, 0);
  writeFileSync(join(checkout, "desktop/package.json"), '{"version":"0.1.0"}\n');
  failsWithoutWrites("bump", "minor", /versions must match/);
  setVersion("1.0.1");
  writeFileSync(join(checkout, "desktop/src-tauri/Cargo.lock"), 'name = "suplex-desktop"\nversion = "1.0.0"\n');
  failsWithoutWrites("bump", "minor", /versions must match/);
  setVersion("1.0.1");
  git("remote", "set-url", "origin", join(scratch, "missing.git"));
  failsWithoutWrites("bump", "minor", /does not appear to be a git repository/);
  git("remote", "set-url", "origin", remote);

  // A tag created remotely during the build must reject the entire push.
  git("tag", "v0.7.0");
  git("add", ".");
  git("commit", "-m", "release");
  git("tag", "-f", "v0.7.0");
  const before = git("ls-remote", "origin", "refs/heads/main", "refs/tags/v0.7.0");
  assert.throws(() => git("push", "--atomic", "origin", "HEAD", "refs/tags/v0.7.0"));
  assert.equal(git("ls-remote", "origin", "refs/heads/main", "refs/tags/v0.7.0"), before);
  git("tag", "v1.0.1");
  git("push", "--atomic", "origin", "HEAD", "refs/tags/v1.0.1");
  assert.equal(git("ls-remote", "origin", "refs/heads/main").split("\t")[0], git("rev-parse", "HEAD"));
  console.log("Release version and atomic push checks passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
