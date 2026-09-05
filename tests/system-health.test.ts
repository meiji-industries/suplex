import { expect, test } from "vitest";

import { getSystemHealthLevel } from "../src/frontend/components/app/system-health.js";
import type { HealthSnapshot } from "../src/health.js";

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
