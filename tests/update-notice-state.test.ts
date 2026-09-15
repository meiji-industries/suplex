import { expect, test } from "vitest";

import { observeRestart, selectUpdateNotice } from "../src/frontend/components/app/update-notice-state.js";

const base = { canRestart: true };

test("an available host update has a compact notice", () => {
  expect(selectUpdateNotice({ ...base, status: { kind: "available" }, availableRevision: "a".repeat(40) })).toEqual({ kind: "available", message: "Forge update available." });
});

test("apply progress and failure stay visible", () => {
  expect(selectUpdateNotice({ ...base, status: { kind: "applying", step: "install", message: "Forge installs dependencies." } })).toEqual({ kind: "progress", message: "Forge installs dependencies." });
  expect(selectUpdateNotice({ ...base, status: { kind: "failed", action: "apply", message: "Forge could not apply the update.", error: "install failed" } })).toEqual({ kind: "failure", message: "Forge could not apply the update." });
});

test("current and check failure states do not create a restart notice", () => {
  expect(selectUpdateNotice({ ...base, status: { kind: "current" } })).toBeUndefined();
  expect(selectUpdateNotice({ ...base, status: { kind: "failed", action: "check", message: "Forge could not check for an update.", error: "offline" } })).toBeUndefined();
});

test("an uncertain POST keeps polling until a new instance or an actual apply failure", () => {
  const attempt = { userId: "user", instanceId: "old-instance" };
  expect(observeRestart(attempt, { ...base, instanceId: "old-instance", status: { kind: "applying", step: "start", message: "Forge reconnects to the host." } })).toBe("wait");
  expect(observeRestart(attempt, { ...base, instanceId: "new-instance", status: { kind: "applying", step: "start", message: "Forge starts the host." } })).toBe("reload");
  expect(observeRestart(attempt, { ...base, instanceId: "old-instance", status: { kind: "failed", action: "apply", message: "Forge could not apply the update.", error: "install failed" } })).toBe("settled");
});
