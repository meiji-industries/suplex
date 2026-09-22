import { tmpdir } from "node:os";
import { expect, test } from "vitest";

import { SuplexSupervisor } from "../src/platform/updates/supervisor.js";

test("a packaged supervisor reports that updates come with the desktop app instead of running git or pnpm", async () => {
  const supervisor = new SuplexSupervisor(tmpdir(), false, true);

  await supervisor.check();
  expect(supervisor.snapshot()).toEqual({
    status: {
      kind: "failed",
      action: "check",
      message: "Updates come with the desktop app.",
      error: "This Suplex ships inside Suplex.app; install the new app to update it.",
    },
    canRestart: true,
  });

  await supervisor.apply();
  expect(supervisor.snapshot().status).toMatchObject({ kind: "failed", action: "apply", message: "Updates come with the desktop app." });
});
