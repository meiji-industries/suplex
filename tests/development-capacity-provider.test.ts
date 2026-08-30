import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { CapacityManager } from "../src/capacity.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivityContext } from "../src/engine/activities/context.js";
import { createDevelopmentActivities } from "../src/engine/activities/development.js";
import type { DeveloperExecutionResult } from "../src/engine/contracts/activities/development.js";

const now = new Date().toISOString();

const baseSha = "a".repeat(40);
function stubResult(): DeveloperExecutionResult {
  return {
    developerExecutionId: "execution_1",
    developerSessionRef: "session_1",
    worktreePath: "/tmp/forge-stub-worktree",
    branchName: "work/task",
    targetBaseSha: baseSha,
    currentStep: null,
    resultCommit: null,
    resultTree: null,
    dirtyState: "clean",
    deliveryArtifactId: "artifact_delivery",
    evidenceArtifactId: "artifact_evidence",
    deliverySummary: "Stub delivery",
    outcome: "completed",
  };
}

test("developer turns are admitted through the builder profile provider bucket", { timeout: 3_000 }, async () => {
  // The tight test timeout is the hang detector: against the literal codex
  // bucket this call never resolves because the codex slots are pre-acquired.
  const root = await mkdtemp(join(tmpdir(), "forge-development-capacity-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_openrouter', 'OpenRouter Builder', 'openrouter', 'glm-5.3-flash', 'medium', 'standard', 1, ?, ?)").run(now, now);
    });
    const config = createTestConfig(root, { externalTurnCapacity: 1, externalTurnCapacityByProvider: { codex: 1, claude: 1, openrouter: 1 } });
    const capacity = new CapacityManager(database, config);
    // Seeded migration profiles give codex MAX(capacity) = 2, so fill both slots.
    const releaseCodex1 = await capacity.acquire("codex");
    const releaseCodex2 = await capacity.acquire("codex");
    const activities = createDevelopmentActivities(createActivityContext(database, config, {
      capacity,
      developer: { run: async () => stubResult() },
    }));
    const result = await activities.runDeveloperExecution({
      taskId: "task_1",
      companyId: "company_1",
      workflowId: "workflow-test-issue-task_1",
      projectId: "project_1",
      projectRevisionId: "revision_1",
      planRevision: 1,
      roleProfiles: { builder: "profile_openrouter" },
      leadSessionRef: "lead_session_1",
      leadOutputArtifactId: "artifact_lead",
    });
    expect(result.outcome).toBe("completed");
    expect(capacity.snapshot("openrouter").openrouter?.activeCount).toBe(0);
    releaseCodex1();
    releaseCodex2();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
