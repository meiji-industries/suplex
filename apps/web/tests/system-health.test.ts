import { expect, test } from "vitest";

import { getSystemHealthLevel } from "../components/app/system-health.js";
import { REQUIRED_HEALTH_CHECK_IDS } from "../contracts/health-checks.js";
import type { HealthSnapshot } from "../contracts/health.js";
import { HealthSnapshotSchema } from "../contracts/health-schema.js";

test("health boundary rejects malformed snapshots", () => {
  expect(HealthSnapshotSchema.safeParse({ ready: "yes" }).success).toBe(false);
});

const snapshot: HealthSnapshot = {
  generatedAt: "2026-08-13T00:00:00.000Z",
  reachableAddress: "http://127.0.0.1:4111",
  ready: true,
  checks: [
    { id: "database", label: "Database", status: "healthy", summary: "Ready", details: {} },
    { id: "backup", label: "Backup verification", status: "unhealthy", summary: "No verified backup is recorded", details: {} },
  ],
};

test("backup verification does not degrade the rolled-up health level", () => {
  expect(getSystemHealthLevel(snapshot, "current")).toBe("green");
  expect(getSystemHealthLevel({ ...snapshot, checks: [...snapshot.checks, { id: "gh-auth", label: "GitHub CLI authentication", status: "unhealthy", summary: "Unavailable", details: {} }] }, "current")).toBe("amber");
});

test("a necessary tool failure makes system health red without changing owned readiness", () => {
  for (const id of REQUIRED_HEALTH_CHECK_IDS) {
    const unhealthy: HealthSnapshot = { ...snapshot, checks: [...snapshot.checks, { id, label: id, status: "unhealthy", summary: "Not available", details: {} }] };
    expect(unhealthy.ready).toBe(true);
    expect(getSystemHealthLevel(unhealthy, "current")).toBe("red");
    expect(getSystemHealthLevel(unhealthy, "stale")).toBe("red");
  }
});

test("provider failures never turn system health red", () => {
  for (const [id, provider] of [["provider:opencode", "opencode"], ["provider:claude-code", "claude-code"], ["provider:codex", "codex"], ["provider:pi", "pi"]] as const) {
    const unhealthy: HealthSnapshot = { ...snapshot, checks: [...snapshot.checks, { id, label: id, status: "unhealthy", summary: "Not signed in", details: {}, provider }] };
    expect(getSystemHealthLevel(unhealthy, "current")).toBe("amber");
  }
});

test("low disk space degrades health while owned readiness stays true", () => {
  const lowDisk: HealthSnapshot = { ...snapshot, checks: [...snapshot.checks, { id: "disk-space", label: "Disk space", status: "warning", summary: "Low disk space", details: {} }] };
  expect(lowDisk.ready).toBe(true);
  expect(getSystemHealthLevel(lowDisk, "current")).toBe("amber");
});
