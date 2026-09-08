import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { configuredEditorLauncher, resolveExecutable, worktreeLaunchers } from "../src/tasks/worktree-open.js";

test("discovers resolved macOS applications with fixed argument arrays", () => {
  const apps = worktreeLaunchers({
    platform: "darwin",
    home: "/Users/test",
    exists: path => ["/System/Library/CoreServices/Finder.app", "/System/Applications/Utilities/Terminal.app", "/Applications/Ghostty.app"].includes(path),
    executable: path => ["/usr/bin/open", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"].includes(path),
    resolveExecutable: () => undefined,
  });
  expect(apps.map(app => app.id)).toEqual(["finder", "vscode", "ghostty", "terminal"]);
  expect(apps.find(app => app.id === "terminal")?.args("/worktrees/a; rm -rf /")).toEqual(["-a", "/System/Applications/Utilities/Terminal.app", "/worktrees/a; rm -rf /"]);
  expect(apps.find(app => app.id === "ghostty")?.args("/worktrees/task")).toEqual(["-na", "/Applications/Ghostty.app", "--args", "--working-directory=/worktrees/task"]);
});

test("does not advertise Linux applications that do not resolve to executable files", () => {
  const apps = worktreeLaunchers({ platform: "linux", resolveExecutable: command => command === "x-terminal-emulator" ? "/usr/bin/x-terminal-emulator" : undefined });
  expect(apps.map(app => app.id)).toEqual(["terminal"]);
  expect(apps[0]?.cwd?.("/worktrees/task")).toBe("/worktrees/task");
});

test("resolves only executable regular files and preserves the configured editor command", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge-worktree-open-"));
  try {
    const executable = join(directory, "editor");
    const nonExecutable = join(directory, "not-executable");
    const folder = join(directory, "folder");
    writeFileSync(executable, "#!/bin/sh\n");
    chmodSync(executable, 0o700);
    writeFileSync(nonExecutable, "#!/bin/sh\n");
    chmodSync(nonExecutable, 0o600);
    mkdirSync(folder);
    expect(resolveExecutable(executable)).toBe(executable);
    expect(resolveExecutable(nonExecutable)).toBeUndefined();
    expect(resolveExecutable(folder)).toBeUndefined();
    expect(configuredEditorLauncher(executable)).toMatchObject({ command: executable, id: "editor" });
    expect(configuredEditorLauncher(nonExecutable)).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
