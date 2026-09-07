import { mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { runCommand } from "./command-runner.js";

export interface GitCommandGuard {
  directory: string;
  gitRealBin?: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export function withWorktreeMiseTrust(env: NodeJS.ProcessEnv, worktreePath: string): NodeJS.ProcessEnv {
  return { ...env, MISE_TRUSTED_CONFIG_PATHS: [env.MISE_TRUSTED_CONFIG_PATHS, worktreePath].filter(Boolean).join(delimiter) };
}

export async function createGitCommandGuard(runtimeRoot: string, name = "worker-guard"): Promise<GitCommandGuard> {
  const directory = join(resolve(runtimeRoot), name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const configuredGitBin = process.env.FORGE_GIT_BIN?.trim();
  const resolvedGitBin = configuredGitBin ? undefined : await runCommand({ taskId: null, stepId: null, command: "which", args: ["git"] });
  const gitBin = configuredGitBin || (resolvedGitBin?.exitCode === 0 ? resolvedGitBin.stdout.trim() : "");
  if (!gitBin) throw new Error("Git is not available for the guarded Worker");
  const resolvedGhBin = await runCommand({ taskId: null, stepId: null, command: "which", args: ["gh"] });
  const ghBin = resolvedGhBin.exitCode === 0 ? resolvedGhBin.stdout.trim() : "";
  const gitGuard = `#!/bin/sh
check_command() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -C|-c|--git-dir|--work-tree|--namespace|--config-env) shift; [ "$#" -gt 0 ] || return 125; shift ;;
      -*) shift ;;
      *) command="$1"; shift; break ;;
    esac
  done
  case "$command" in
    push|clean|reset|checkout|switch|worktree|update-ref|filter-repo|gc|prune) echo "Forge Worker policy blocked git $command" >&2; return 125 ;;
  esac
  for arg in "$@"; do
    [ "$arg" != -- ] || break
    case "$command:$arg" in
      commit:--amend|branch:-D|branch:-d|branch:--delete|branch:--force|branch:-f) echo "Forge Worker policy blocked destructive git option $arg" >&2; return 125 ;;
    esac
  done
}
check_command "$@" || exit 125
exec "$FORGE_GIT_REAL_BIN" "$@"
`;
  const ghGuard = `#!/bin/sh
case "$1 $2" in
  "run view"|"run list"|"pr view"|"pr list"|"pr diff"|"pr checks"|"repo view"|"issue view"|"issue list")
    if [ -n "$FORGE_GH_REAL_BIN" ]; then exec "$FORGE_GH_REAL_BIN" "$@"; fi ;;
esac
echo "Forge Worker policy blocks provider-side GitHub mutation" >&2
exit 125
  `;
  await writeFile(join(directory, "git"), gitGuard, { encoding: "utf8", mode: 0o700 });
  await writeFile(join(directory, "gh"), ghGuard, { encoding: "utf8", mode: 0o700 });
  return {
    directory,
    gitRealBin: gitBin,
    env: { ...process.env, PATH: `${directory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`, FORGE_GIT_REAL_BIN: gitBin, FORGE_GH_REAL_BIN: ghBin, FORGE_GIT_GUARD_DIR: directory },
    async cleanup() { await rm(directory, { recursive: true, force: true }); },
  };
}
