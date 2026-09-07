import { mkdir } from "node:fs/promises";

import { createTestConfig } from "../../src/config.js";
import { SelfUpdateFailure, SelfUpdateService, SelfUpdateStore } from "../../src/self-update.js";

const root = process.argv.at(-1);
if (!root) throw new Error("The watch probe requires a fixture root");

const config = createTestConfig(root);
await mkdir(config.runtimeRoot, { recursive: true });
let gitCalled = false;
const finish = (message: string, exitCode: number): void => {
  process.stdout.write(`${message}\n`, () => {
    if (process.env.WATCH_PROBE_KILL_PARENT === "1") {
      try { process.kill(process.ppid, "SIGTERM"); } catch { /* The watcher may already be gone. */ }
    }
    process.exit(exitCode);
  });
};
const service = new SelfUpdateService({
  config,
  argv: process.argv,
  execArgv: process.execArgv,
  environment: process.env,
  runGit: async () => {
    gitCalled = true;
    return "";
  },
});

try {
  await service.acceptRestart("a".repeat(40));
  finish("watch-probe:accepted", 1);
} catch (error: unknown) {
  const code = error instanceof SelfUpdateFailure ? error.code : "unknown";
  const lock = await new SelfUpdateStore(config.runtimeRoot).readLock();
  const valid = code === "watch_ownership_unsupported" && !lock && !gitCalled;
  finish(`watch-probe:${code}:lock=${lock ? "present" : "absent"}:git=${gitCalled ? "called" : "not-called"}`, valid ? 0 : 1);
}
