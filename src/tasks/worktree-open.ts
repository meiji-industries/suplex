import { constants, accessSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const WorktreeAppIds = ["finder", "cursor", "vscode", "ghostty", "terminal"] as const;
export type WorktreeAppId = typeof WorktreeAppIds[number];
export type WorktreeOpenApp = WorktreeAppId | "editor";

export type WorktreeLauncher = { id: WorktreeAppId; label: string; command: string; args: (path: string) => string[]; cwd?: (path: string) => string };
export type ConfiguredEditorLauncher = Omit<WorktreeLauncher, "id"> & { id: "editor" };

type Discovery = {
  platform: NodeJS.Platform;
  home?: string;
  exists?: (path: string) => boolean;
  executable?: (path: string) => boolean;
  resolveExecutable?: (command: string) => string | undefined;
};

function executable(path: string): boolean {
  try {
    const stat = statSync(path);
    accessSync(path, constants.X_OK);
    return stat.isFile();
  } catch {
    return false;
  }
}

export function resolveExecutable(command: string, isExecutable = executable): string | undefined {
  if (command.includes("/")) return isExecutable(command) ? command : undefined;
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function configuredEditorLauncher(command = process.env.SUPLEX_EDITOR_COMMAND ?? "code", resolve = resolveExecutable): ConfiguredEditorLauncher | undefined {
  const executable = resolve(command);
  return executable ? { id: "editor", label: "Editor", command: executable, args: path => [path] } : undefined;
}

function macAppBundle(name: string, directories: string[], exists: (path: string) => boolean): string | undefined {
  return directories.map(directory => join(directory, name)).find(exists);
}

function macBundledExecutable(name: string, relativePath: string, directories: string[], executable: (path: string) => boolean): string | undefined {
  return directories.map(directory => join(directory, name, relativePath)).find(executable);
}

export function worktreeLaunchers(discovery: Discovery = { platform: process.platform }): WorktreeLauncher[] {
  const isExecutable = discovery.executable ?? executable;
  const exists = discovery.exists ?? existsSync;
  const resolve = discovery.resolveExecutable ?? ((command: string) => resolveExecutable(command, isExecutable));
  if (discovery.platform === "darwin") {
    const open = "/usr/bin/open";
    if (!isExecutable(open)) return [];
    const bundles = ["/Applications", "/System/Applications", join(discovery.home ?? process.env.HOME ?? "", "Applications")];
    const finder = exists("/System/Library/CoreServices/Finder.app") ? { id: "finder" as const, label: "Finder", command: open, args: (path: string) => [path] } : undefined;
    const cursor = resolve("cursor") ?? macBundledExecutable("Cursor.app", "Contents/Resources/app/bin/cursor", bundles, isExecutable);
    const vscode = resolve("code") ?? macBundledExecutable("Visual Studio Code.app", "Contents/Resources/app/bin/code", bundles, isExecutable);
    const ghostty = macAppBundle("Ghostty.app", bundles, exists);
    const terminalBundle = "/System/Applications/Utilities/Terminal.app";
    const terminal = exists(terminalBundle)
      ? { id: "terminal" as const, label: "Terminal", command: open, args: (path: string) => ["-a", terminalBundle, path] }
      : undefined;
    return [
      ...(finder ? [finder] : []),
      ...(cursor ? [{ id: "cursor" as const, label: "Cursor", command: cursor, args: (path: string) => [path] }] : []),
      ...(vscode ? [{ id: "vscode" as const, label: "VS Code", command: vscode, args: (path: string) => [path] }] : []),
      ...(ghostty ? [{ id: "ghostty" as const, label: "Ghostty", command: open, args: (path: string) => ["-na", ghostty, "--args", `--working-directory=${path}`] }] : []),
      ...(terminal ? [terminal] : []),
    ];
  }
  if (discovery.platform === "linux") return [
    ...(resolve("cursor") ? [{ id: "cursor" as const, label: "Cursor", command: resolve("cursor")!, args: (path: string) => [path] }] : []),
    ...(resolve("code") ? [{ id: "vscode" as const, label: "VS Code", command: resolve("code")!, args: (path: string) => [path] }] : []),
    ...(resolve("ghostty") ? [{ id: "ghostty" as const, label: "Ghostty", command: resolve("ghostty")!, args: (path: string) => ["+new-window", "--working-directory", path] }] : []),
    ...(resolve("x-terminal-emulator") ? [{ id: "terminal" as const, label: "Terminal", command: resolve("x-terminal-emulator")!, args: () => [], cwd: (path: string) => path }] : []),
  ];
  return [];
}

export function worktreeLauncher(app: WorktreeOpenApp, launchers = worktreeLaunchers(), editor = configuredEditorLauncher()): WorktreeLauncher | ConfiguredEditorLauncher | undefined {
  if (app === "editor") return editor;
  return launchers.find(item => item.id === app);
}
