import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { AgentFailure } from "../src/agent-failure.js";
import { DeveloperService, finalizeDeveloperSourceCommit } from "../src/codex-developer.js";
import { runCommand } from "../src/command-runner.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import type { HerdrTurnInput, HerdrTurnOutput } from "../src/herdr-turn-runner.js";

export async function command(command: string, args: string[], cwd: string): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command, args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-codex-developer-"));
  const repository = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repository, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(repository, "README.md"), "fixture\n");
  await writeFile(join(repository, "package.json"), '{"scripts":{"test":"node -e \'process.exit(0)\'"}}');
  await command("git", ["init"], repository);
  await command("git", ["config", "user.email", "forge@example.invalid"], repository);
  await command("git", ["config", "user.name", "Forge"], repository);
  await command("git", ["add", "."], repository);
  await command("git", ["commit", "-m", "fixture"], repository);
  const targetSha = await command("git", ["rev-parse", "HEAD"], repository);
  const config = createTestConfig(root, { repositoryRoot: root, artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime") });
  const database = new ForgeDatabase(config.databasePath);
  const artifacts = new ArtifactStore(config.artifactRoot);
  const brief = await artifacts.put("company_1", "task-brief", { filename: "brief.md", mimeType: "text/markdown", bytes: Buffer.from("Fix fixture.") });
  const plan = await artifacts.put("company_1", "lead-plan", { filename: "plan.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ kind: "plan", summary: "Fixture", gitPresentation: { branchSlug: "fixture", pullRequestTitle: "Fixture", pullRequestDescription: "Fixture" }, reproduction: null, rootCauseAnalysis: null, steps: [{ number: 1, instruction: "Add marker", verification: "Marker exists", verificationCommands: [] }], compatibilityAnalysis: "None", operationalAnalysis: "None", verificationStrategy: "Check", unresolvedTechnicalQuestions: [], materialCategories: [], affectedPaths: ["MARKER.md"], materiality: [] })) });
  const evidence = await artifacts.put("company_1", "agent-evidence", { filename: "lead.jsonl", mimeType: "application/x-ndjson", bytes: Buffer.from("{}\n") });
  const taskConfiguration = await artifacts.put("company_1", "task-project-configuration", { filename: "configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ projectId: "project_1", projectName: "Project", repositoryPath: repository, worktreeRoot, repository: "acme/forge", baseBranch: "main", targetBranch: "main", baseSha: targetSha, targetSha, setupCommand: "true", verificationCommand: "pnpm test", requiredChecks: [], roleAgents: { builder: "profile_1" }, roleProfiles: { builder: "profile_1" }, capturedAt: new Date().toISOString() })) });
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_1', 'Forge', 'forge', 'admin', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_1', 'Developer', 'codex', 'gpt-5-codex', 'medium', 'standard', 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', ?, ?, 'acme/forge', 'main', 'main', '', 'pnpm test', '[]', '{}', 'active', ?, ?)").run(repository, worktreeRoot, now, now);
    for (const artifact of [brief, plan, evidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, task_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, 'task_1', ?, ?, ?, ?, ?, ?, ?)").run(taskConfiguration.id, taskConfiguration.companyId, taskConfiguration.kind, taskConfiguration.filename, taskConfiguration.mimeType, taskConfiguration.byteSize, taskConfiguration.sha256, taskConfiguration.storagePath, taskConfiguration.createdAt);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, project_configuration_artifact_id, project_configuration_captured_at, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Fixture', ?, '[]', '{}', 0, 'workflow_1', 'revision_1', ?, ?, 'fixture', ?, ?)").run(brief.id, taskConfiguration.id, now, now, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id, output_kind, output_revision, output_artifact_id, output_summary) VALUES ('lead_1', 'task_1', 'company_1', 'workflow_1', 'planner', 'completed', 1, 'session_lead', ?, ?, ?, 'plan', 1, ?, 'Fixture')").run(now, now, evidence.id, plan.id);
  });
  return { root, database, config, input: { taskId: "task_1", companyId: "company_1", workflowId: "workflow_1", projectId: "project_1", projectRevisionId: "revision_1", planRevision: 1, roleProfiles: { builder: "profile_1" }, leadSessionRef: "session_lead", leadOutputArtifactId: plan.id } };
}

export function fakeTurnRunner(handler: (input: HerdrTurnInput<unknown>) => unknown | Promise<unknown>) {
  const calls: HerdrTurnInput<unknown>[] = [];
  return { calls, turnRunner: { async run<T>(input: HerdrTurnInput<T>): Promise<HerdrTurnOutput<T>> {
    calls.push(input as HerdrTurnInput<unknown>);
    const result = await handler(input as HerdrTurnInput<unknown>);
    if (result instanceof Error) throw result;
    return { turnId: `turn_${calls.length}`, sessionId: "codex_uuid", roleSessionId: "session_0123456789abcdef01234567", result: result as T, resultHash: `hash_${calls.length}` };
  } } };
}

test("Developer delivery uses the fake turn role session and preserves delivery assertions", async () => {
  const value = await fixture();
  const worktree = join(value.root, "worktrees", "task_1");
  const fake = fakeTurnRunner(async () => {
    await writeFile(join(worktree, "MARKER.md"), "done\n");
    await command("git", ["add", "MARKER.md"], worktree);
    await command("git", ["commit", "-m", "deliver"], worktree);
    return { kind: "delivery", summary: "Marker delivered", steps: [{ number: 1, status: "completed", filesChanged: ["MARKER.md"], commandsRun: [], testResults: [], notes: "done" }], authorizedStepsNotCompleted: [], resultCommit: "a".repeat(40), resultTree: "b".repeat(40), dirtyState: "clean", blocker: null };
  });
  try {
    const result = await new DeveloperService(value.database, value.config, { turnRunner: fake.turnRunner }).run(value.input);
    expect(result).toMatchObject({ outcome: "completed", deliverySummary: "Marker delivered", developerSessionRef: "session_0123456789abcdef01234567" });
    expect(fake.calls[0]).toMatchObject({ promptKind: "implementation", sessionRole: "developer", executionRole: "builder", ledger: "developer" });
    expect(value.database.authQuery((db) => db.prepare("SELECT session_ref, status FROM forge_developer_executions WHERE id = ?").get(result.developerExecutionId))).toEqual({ session_ref: "session_0123456789abcdef01234567", status: "completed" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("a Developer retry uses current project prompts and records prompt repinning", async () => {
  const value = await fixture();
  const worktree = join(value.root, "worktrees", "task_1");
  const artifacts = new ArtifactStore(value.config.artifactRoot);
  const now = new Date().toISOString();
  const pinned = await artifacts.put("company_1", "task-prompt-set", { filename: "pinned-prompts.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ "developer/execution.md": "PINNED FIRST ATTEMPT {{title}}" })) });
  const configuration = await artifacts.put("company_1", "task-project-configuration", { filename: "retry-configuration.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ projectId: "project_1", projectName: "Project", repositoryPath: join(value.root, "repo"), worktreeRoot: join(value.root, "worktrees"), repository: "acme/forge", baseBranch: "main", targetBranch: "main", baseSha: await command("git", ["rev-parse", "HEAD"], join(value.root, "repo")), targetSha: await command("git", ["rev-parse", "HEAD"], join(value.root, "repo")), setupCommand: "true", verificationCommand: "pnpm test", requiredChecks: [], roleAgents: { builder: "profile_1" }, roleProfiles: { builder: "profile_1" }, capturedAt: now, prompts: { artifactId: pinned.id, sha256: pinned.sha256, overrides: [] } })) });
  const fake = fakeTurnRunner(async () => {
    await writeFile(join(worktree, "MARKER.md"), "done\n");
    await command("git", ["add", "MARKER.md"], worktree);
    await command("git", ["commit", "-m", "retry delivery"], worktree);
    return { kind: "delivery", summary: "Retry delivered", steps: [{ number: 1, status: "completed", filesChanged: ["MARKER.md"], notes: "done" }], authorizedStepsNotCompleted: [], resultCommit: "a".repeat(40), resultTree: "b".repeat(40), dirtyState: "clean", blocker: null };
  });
  try {
    value.database.authQuery((db) => {
      for (const artifact of [pinned, configuration]) db.prepare("INSERT INTO forge_artifacts (id, company_id, task_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, 'task_1', ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("UPDATE forge_tasks SET project_configuration_artifact_id = ? WHERE id = 'task_1'").run(configuration.id);
      db.prepare("INSERT INTO forge_prompt_overrides (id, scope, project_id, scope_key, template_id, mode, content, base_template_sha256, current_revision, updated_by_user_id, created_at, updated_at) VALUES ('override', 'project', 'project_1', 'project_1', 'developer/execution', 'append', 'CURRENT RETRY PROMPT', 'base', 1, 'user_1', ?, ?)").run(now, now);
    });

    const result = await new DeveloperService(value.database, value.config, { turnRunner: fake.turnRunner }).run({ ...value.input, developerAttempt: 2 });
    expect(fake.calls[0]!.prompt).toContain("CURRENT RETRY PROMPT");
    expect(fake.calls[0]!.prompt).not.toContain("PINNED FIRST ATTEMPT");
    const evidence = value.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ?").get(result.evidenceArtifactId) as { storage_path: string; sha256: string });
    expect(artifacts.getArtifactSync({ companyId: "company_1", storagePath: evidence.storage_path, sha256: evidence.sha256 }).toString("utf8")).toContain('"promptsRepinned":true');
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("required Developer proof is ingested and persisted without local paths", async () => {
  const value = await fixture(), worktree = join(value.root, "worktrees", "task_1");
  const proof = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.alloc(17), Buffer.from([0, 0, 0, 0]), Buffer.from("IEND"), Buffer.alloc(4)]);
  const fake = fakeTurnRunner(async () => {
    await mkdir(join(worktree, ".forge-proof"), { recursive: true }); await writeFile(join(worktree, ".forge-proof", "screen.png"), proof); await writeFile(join(worktree, "MARKER.md"), "done\n");
    await command("git", ["add", "MARKER.md"], worktree); await command("git", ["commit", "-m", "deliver with proof"], worktree);
    return { kind: "delivery", summary: "Proof delivered", steps: [{ number: 1, status: "completed", filesChanged: ["MARKER.md"], notes: "done" }], authorizedStepsNotCompleted: [], resultCommit: "a".repeat(40), resultTree: "b".repeat(40), dirtyState: "clean", blocker: null, visualEvidence: { captured: true, captures: [{ path: ".forge-proof/screen.png", caption: "Desktop", viewport: { width: 1440, height: 900 } }] } };
  });
  try {
    const result = await new DeveloperService(value.database, value.config, { turnRunner: fake.turnRunner }).run({ ...value.input, visualEvidence: "required" });
    expect(result.outcome).toBe("completed");
    const row = value.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ?").get(result.deliveryArtifactId) as { storage_path: string; sha256: string });
    const delivery = JSON.parse(new ArtifactStore(value.config.artifactRoot).getArtifactSync({ companyId: "company_1", storagePath: row.storage_path, sha256: row.sha256 }).toString("utf8"));
    expect(delivery.visualEvidence).toMatchObject({ captured: true, manifestArtifactId: expect.stringMatching(/^proof_manifest_/), artifactIds: [expect.stringMatching(/^proof_image_/)] });
    expect(JSON.stringify(delivery)).not.toContain(".forge-proof");
    expect(await command("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", ".forge-proof"], result.worktreePath)).toBe("");
    expect(await command("git", ["diff", "--name-only", result.targetBaseSha, result.resultCommit!], result.worktreePath)).toBe("MARKER.md");
    expect(await command("git", ["status", "--porcelain", "--untracked-files=all"], result.worktreePath)).toBe("");
    const imageRow = value.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ?").get(delivery.visualEvidence.artifactIds[0]!) as { storage_path: string; sha256: string });
    expect(new ArtifactStore(value.config.artifactRoot).getArtifactSync({ companyId: "company_1", storagePath: imageRow.storage_path, sha256: imageRow.sha256 })).toEqual(proof);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("source finalization preserves tracked staging content and excludes reported proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-proof-index-"));
  try {
    await mkdir(join(root, ".forge-proof"), { recursive: true }); await writeFile(join(root, ".forge-proof", "keep.txt"), "keep\n"); await writeFile(join(root, "README.md"), "base\n");
    await command("git", ["init"], root); await command("git", ["config", "user.email", "forge@example.invalid"], root); await command("git", ["config", "user.name", "Forge"], root); await command("git", ["add", "README.md", ".forge-proof/keep.txt"], root); await command("git", ["commit", "-m", "base"], root);
    const base = await command("git", ["rev-parse", "HEAD"], root);
    await writeFile(join(root, ".forge-proof", "keep.txt"), "changed\n"); await command("git", ["add", ".forge-proof/keep.txt"], root);
    await writeFile(join(root, ".forge-proof", "unreported.png"), "transient"); await writeFile(join(root, "CODE.md"), "code\n");
    await finalizeDeveloperSourceCommit(root, base, []);
    expect(await command("git", ["show", "HEAD:.forge-proof/keep.txt"], root)).toBe("keep"); expect(await command("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", ".forge-proof/unreported.png"], root)).toBe("");
    expect(await command("git", ["diff", "--cached", "--name-only", "--", ".forge-proof/keep.txt"], root)).toBe(".forge-proof/keep.txt");
    await command("git", ["restore", "--staged", "--worktree", ".forge-proof/keep.txt"], root);
    await rm(join(root, ".forge-proof", "unreported.png")); await writeFile(join(root, ".forge-proof", "reported.png"), "proof"); await writeFile(join(root, "CODE2.md"), "code2\n");
    await finalizeDeveloperSourceCommit(root, base, [".forge-proof/reported.png"]);
    expect(await command("git", ["show", "HEAD:.forge-proof/keep.txt"], root)).toBe("keep"); expect(await command("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", ".forge-proof/reported.png"], root)).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source finalization rejects agent-controlled proof pathspecs without repository mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-proof-pathspec-"));
  try {
    await writeFile(join(root, "README.md"), "base\n");
    await command("git", ["init"], root); await command("git", ["config", "user.email", "forge@example.invalid"], root); await command("git", ["config", "user.name", "Forge"], root); await command("git", ["add", "README.md"], root); await command("git", ["commit", "-m", "base"], root);
    const head = await command("git", ["rev-parse", "HEAD"], root), tree = await command("git", ["write-tree"], root), status = await command("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
    for (const path of ["/tmp/proof.png", "../proof.png", ".forge-proof/../proof.png", ".forge-proof\\proof.png", ":(glob).forge-proof/*.png", ".forge-proof/:(glob)*", ".forge-proof", ".forge-proof/", ".forge-proof/bad\0.png"]) {
      await expect(finalizeDeveloperSourceCommit(root, head, [path])).rejects.toMatchObject({ code: "invalid-proof" });
      expect(await command("git", ["rev-parse", "HEAD"], root)).toBe(head);
      expect(await command("git", ["write-tree"], root)).toBe(tree);
      expect(await command("git", ["status", "--porcelain=v1", "--untracked-files=all"], root)).toBe(status);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("implementation fails loudly when its frozen Builder profile no longer resolves", async () => {
  const value = await fixture();
  const worktree = join(value.root, "worktrees", "task_1");
  const fake = fakeTurnRunner(async () => {
    await writeFile(join(worktree, "MARKER.md"), "done\n");
    await command("git", ["add", "MARKER.md"], worktree);
    await command("git", ["commit", "-m", "deliver"], worktree);
    return { kind: "delivery", summary: "Fallback delivered", steps: [{ number: 1, status: "completed", filesChanged: ["MARKER.md"], commandsRun: [], testResults: [], notes: "done" }], authorizedStepsNotCompleted: [], resultCommit: "a".repeat(40), resultTree: "b".repeat(40), dirtyState: "clean", blocker: null };
  });
  try {
    value.database.authQuery((db) => {
      db.prepare("DELETE FROM forge_profiles WHERE id = 'profile_1'").run();
      db.prepare("UPDATE forge_profiles SET model = 'gpt-5.6-terra', reasoning_level = 'medium', service_priority = 'fast'").run();
    });

    await expect(new DeveloperService(value.database, value.config, { turnRunner: fake.turnRunner }).run(value.input)).rejects.toMatchObject({ code: "developer-profile-unavailable", message: "Developer profile profile_1 is unavailable" });
    expect(fake.calls).toEqual([]);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("implementation fails loudly when no fallback Developer profile exists", async () => {
  const value = await fixture();
  const fake = fakeTurnRunner(() => new Error("runner must not start"));
  try {
    value.database.authQuery((db) => db.prepare("DELETE FROM forge_profiles").run());

    await expect(
      new DeveloperService(value.database, value.config, { turnRunner: fake.turnRunner }).run(value.input),
    ).rejects.toMatchObject({ code: "developer-profile-unavailable" });
    expect(fake.calls).toEqual([]);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("a thrown developer turn finalizes its execution and conflict claims are non-retryable", async () => {
  const value = await fixture();
  const fake = fakeTurnRunner(() => new Error("turn lost"));
  try {
    await expect(new DeveloperService(value.database, value.config, { turnRunner: fake.turnRunner }).run({ ...value.input, developerTurnExecutionId: "developer_throw" })).rejects.toMatchObject({ code: "developer-failed" });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_summary FROM forge_developer_executions WHERE id = 'developer_throw'").get())).toEqual({ status: "failed", failure_summary: "Builder could not start: turn lost" });
    expect(value.database.authQuery((db) => db.prepare("SELECT count(*) AS count FROM forge_developer_executions WHERE status IN ('starting', 'running')").get())).toEqual({ count: 0 });
    const conflict = new AgentFailure("developer-result-claim-conflict", "conflict", { nonRetryable: true });
    expect(conflict).toMatchObject({ code: "developer-result-claim-conflict", nonRetryable: true });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("a retry returns its recorded claim without rerunning the Developer", async () => {
  const value = await fixture();
  const fake = fakeTurnRunner(() => new Error("runner must not start"));
  const result = { developerExecutionId: "developer_claimed", developerSessionRef: "session", worktreePath: "/worktree", branchName: "work/claimed", targetBaseSha: "a".repeat(40), currentStep: null, resultCommit: "b".repeat(40), resultTree: "c".repeat(40), dirtyState: "clean", deliveryArtifactId: "delivery", evidenceArtifactId: "evidence", deliverySummary: "Already completed", outcome: "completed" };
  try {
    const artifactId = (value.database.authQuery((db) => db.prepare("SELECT id FROM forge_artifacts LIMIT 1").get()) as { id: string }).id;
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)").run("developer_claimed", "task_1", "company_1", "workflow_1", 1, 1, "work/claimed", "/worktree", "a".repeat(40), new Date().toISOString()));
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_developer_result_claims (execution_id, claim_key, result_hash, activity_result_json, delivery_artifact_id, evidence_artifact_id, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("developer_claimed", "developer:developer_claimed", "hash", JSON.stringify(result), artifactId, artifactId, new Date().toISOString()));
    await expect(new DeveloperService(value.database, value.config, { turnRunner: fake.turnRunner }).run({ ...value.input, developerTurnExecutionId: "developer_claimed" })).resolves.toEqual(result);
    expect(fake.calls).toEqual([]);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
