import { mkdir, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

import { Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { chromium } from "playwright";
import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { AttentionService } from "../src/attention.js";
import { createForgeServer, type ForgeServer } from "../src/server.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createGithubAdapter } from "../src/github.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";
import { createActivities } from "../src/temporal/activities.js";
import { ensureTemporalFoundation, executeIssueCommand, queryIssueWorkflow, startIssueWorkflow } from "../src/temporal/service.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, newSessionToken } from "../src/auth-identifiers.js";

const runRealJourney = process.env.FORGE_RUN_REAL_CODEX === "1";

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a Temporal port"));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function stableOverview(value: ReturnType<AttentionService["list"]>): unknown {
  return value.map((company) => ({
    companyId: company.companyId,
    attention: company.attention.map((item) => ({ id: item.id, category: item.category, sourceRevision: item.sourceRevision, actions: item.actions.map((action) => action.command) })),
    activeIssueCount: company.activeIssueCount,
    phases: company.phases,
    attentionCount: company.attentionCount,
    recentOutcomes: company.recentOutcomes.map((outcome) => ({ taskId: outcome.taskId, phase: outcome.phase, sourceRevision: outcome.sourceRevision ?? null })),
  }));
}

test.skipIf(!runRealJourney)("real Codex/GitHub attention decision produces a sanitized rebuild receipt", async () => {
  const repositoryPath = process.env.FORGE_REAL_REPOSITORY_PATH?.trim();
  const repositoryIdentity = process.env.FORGE_REAL_GITHUB_REPOSITORY?.trim();
  if (!repositoryPath || !repositoryIdentity) throw new Error("FORGE_REAL_REPOSITORY_PATH and FORGE_REAL_GITHUB_REPOSITORY are required");
  const realModel = process.env.FORGE_CODEX_REAL_MODEL?.trim();
  if (!realModel) throw new Error("FORGE_CODEX_REAL_MODEL is required for the real journey");

  const github = createGithubAdapter();
  await github.checkAuthentication();
  const repository = await github.getRepository({ cwd: repositoryPath, nameWithOwner: repositoryIdentity });
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "forge-real-attention-")));
  const temporalPort = await availablePort();
  const httpPort = await availablePort();
  let config = createTestConfig(root, {
    repositoryRoot: dirname(repositoryPath),
    taskQueue: `tasks-real-attention-${process.pid}-${randomUUID().slice(0, 8)}`,
    temporalAddress: `127.0.0.1:${temporalPort}`,
    reachableAddress: `http://127.0.0.1:${httpPort}`,
  });
  let temporalProcess: ChildProcess | undefined;
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;
  let workerConnection: NativeConnection | undefined;
  let database: ForgeDatabase | undefined;
  let api: ForgeServer | undefined;

  try {
    temporalProcess = spawn("temporal", ["server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(temporalPort), "--db-filename", join(root, "temporal.db"), "--namespace", config.temporalNamespace, "--search-attribute", "CompanyId=Keyword", "--search-attribute", "ProjectId=Keyword", "--search-attribute", "IssueId=Keyword"], { stdio: "ignore" });
    let temporalConnection: Connection | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        temporalConnection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "1 second" });
        break;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      }
    }
    if (!temporalConnection) throw new Error("Temporal did not become available");
    await ensureTemporalFoundation(temporalConnection, config);
    temporalConnection.close();

    database = new ForgeDatabase(config.databasePath);
    const artifacts = new ArtifactStore(config.artifactRoot);
    const brief = await artifacts.put("real-company", "task-brief", { filename: "real-attention.md", mimeType: "text/markdown", bytes: Buffer.from("Implement a small user-visible improvement to the existing Forge Attention page: show a compact last-refreshed timestamp beside the current projection health indicator. This is a material user_visible_behavior change. Produce a normal implementation plan with concrete files and verification steps; do not return a decision blocker or ask for clarification. The owner will approve the completed plan in Forge before development starts.") });
    const quietBrief = await artifacts.put("real-company", "task-brief", { filename: "real-quiet.md", mimeType: "text/markdown", bytes: Buffer.from("Routine read-only housekeeping: report that no action is needed. Do not inspect or modify source files. Return a normal plan with materialCategories set to [] and do not create a decision blocker or request approval.") });
    const now = new Date().toISOString();
    const workflowPrefix = runtimeIdentifiers(config.installationId).workflowPrefix;
    const sessionToken = newSessionToken();
    const csrfToken = randomUUID();
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('real-admin', 'Real Admin', 'real-admin@forge.local', 'admin', 'active', ?, ?), ('real-member', 'Real Member', 'real-member@forge.local', 'member', 'active', ?, ?)").run(now, now, now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('real-company', 'Real Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES ('real-member', 'real-company', ?)").run(now);
      db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('real-profile', 'Real Codex profile', 'codex', ?, 'medium', 'standard', 2, ?, ?)").run(realModel, now, now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('real-project', 'real-company', 'Real Project', ?, ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', 'real-revision', ?, ?)").run(repositoryPath, join(root, "worktrees"), repository.nameWithOwner, now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, state, created_at) VALUES ('real-revision', 'real-project', 1, 'real-identity', ?, ?, ?, 'real-admin', 'accepted', ?)").run(JSON.stringify({ repository: repository.nameWithOwner.toLowerCase(), repositoryPath, worktreeRoot: join(root, "worktrees"), baseBranch: "main", targetBranch: "main", baseSha: "0".repeat(40), targetSha: "0".repeat(40), requiredChecks: [] }), "0".repeat(40), "0".repeat(40), now);
      for (const artifact of [brief, quietBrief]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('real-decision', 'real-company', 'real-project', 'Real material decision', ?, '[]', '{\"lead\":\"real-profile\"}', 0, ?, 'real-revision', 'real-decision-key', ?, ?), ('real-quiet', 'real-company', 'real-project', 'Real quiet work', ?, '[]', '{\"lead\":\"real-profile\"}', 0, ?, 'real-revision', 'real-quiet-key', ?, ?)").run(brief.id, `${workflowPrefix}-issue-real-decision`, now, now, quietBrief.id, `${workflowPrefix}-issue-real-quiet`, now, now);
      db.prepare("INSERT INTO forge_sessions (id, token_hash, user_id, expires_at, created_at, revoked_at, token_version) VALUES ('real-session', ?, 'real-admin', ?, ?, NULL, 1)").run(createHash("sha256").update(sessionToken).digest("hex"), new Date(Date.now() + 3_600_000).toISOString(), now);
    });

    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({ connection: workerConnection, namespace: config.temporalNamespace, taskQueue: config.taskQueue, workflowsPath: resolve("src/temporal/workflows.ts"), activities: createActivities(database, config) });
    workerRun = worker.run();
    api = await createForgeServer(config);

    const started = await startIssueWorkflow(config, { companyId: "real-company", projectId: "real-project", issueId: "real-decision", projectRevisionId: "real-revision", briefArtifactId: brief.id, briefSha256: brief.sha256, imageArtifactIds: [], roleProfiles: { planner: "real-profile" }, supplementalReview: false });
    const quietStarted = await startIssueWorkflow(config, { companyId: "real-company", projectId: "real-project", issueId: "real-quiet", projectRevisionId: "real-revision", briefArtifactId: quietBrief.id, briefSha256: quietBrief.sha256, imageArtifactIds: [], roleProfiles: { planner: "real-profile" }, supplementalReview: false });
    const [planned, quietPlanned] = await Promise.all([
      executeIssueCommand(config, started.workflowId, "start_planning", { expectedRevision: 0, actorUserId: "real-admin" }),
      executeIssueCommand(config, quietStarted.workflowId, "start_planning", { expectedRevision: 0, actorUserId: "real-admin" }),
    ]);
    expect(planned).toMatchObject({ phase: "approval", planMaterial: true, leadOutputKind: "plan" });
    expect(quietPlanned.revision).toBeGreaterThan(0);
    expect(quietPlanned.phase).toBe("ready_for_development");
    const githubChecks = github.listChecks ? await github.listChecks({ cwd: repositoryPath, nameWithOwner: repository.nameWithOwner, ref: "main" }) : [];
    const attention = new AttentionService(database, new (await import("../src/auth.js")).AuthService(database, config), artifacts);
    const beforeDecision = attention.list("real-admin");
    const memberBeforeDecision = attention.list("real-member");
    const item = beforeDecision.flatMap((company) => company.attention).find((candidate) => candidate.taskId === "real-decision");
    expect(item).toBeDefined();
    expect(memberBeforeDecision.flatMap((company) => company.attention).map((candidate) => candidate.id)).toContain(item!.id);
    expect(beforeDecision.flatMap((company) => company.attention).some((candidate) => candidate.taskId === "real-quiet")).toBe(false);
    expect(item!.actions.map((action) => action.command)).toContain("approve_plan");
    await api.app.listen({ host: "127.0.0.1", port: httpPort });
    const apiAddress = api.app.server.address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("Real attention server did not expose a port");
    const browser = await chromium.launch({ headless: true });
    const browserResults: { desktop?: { viewport: { width: number; height: number } | null; itemVisible: boolean; screenshot: string }; narrow?: { viewport: { width: number; height: number } | null; itemVisible: boolean; screenshot: string } } = {};
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      await context.addCookies([{ name: SESSION_COOKIE_NAME, value: sessionToken, domain: "127.0.0.1", path: "/" }, { name: CSRF_COOKIE_NAME, value: csrfToken, domain: "127.0.0.1", path: "/" }]);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${apiAddress.port}/attention?company=real-company`);
      await page.getByText("Real material decision", { exact: true }).waitFor();
      const desktopViewport = page.viewportSize();
      const desktopScreenshot = resolve(".scratch/forge-mvp/receipts/attention-real-desktop.png");
      await mkdir(dirname(desktopScreenshot), { recursive: true });
      await page.screenshot({ path: desktopScreenshot, fullPage: true });
      browserResults.desktop = { viewport: desktopViewport, itemVisible: await page.getByText("Real material decision", { exact: true }).isVisible(), screenshot: basename(desktopScreenshot) };
      await page.getByText("Real material decision", { exact: true }).click();
      const approveButton = page.getByRole("button", { name: "Approve plan" });
      await approveButton.click();
      const staleNotice = page.getByRole("status");
      try {
        await staleNotice.waitFor({ timeout: 5_000 });
        if ((await staleNotice.textContent())?.includes("This issue changed")) await approveButton.click();
      } catch {
        // The first revision may still be current; no refetch is needed.
      }
      await page.getByText("Real material decision", { exact: true }).waitFor({ state: "detached", timeout: 60_000 });
      const narrow = await context.newPage();
      await narrow.setViewportSize({ width: 390, height: 844 });
      await narrow.goto(`http://127.0.0.1:${apiAddress.port}/attention?company=real-company`);
      const narrowScreenshot = resolve(".scratch/forge-mvp/receipts/attention-real-narrow.png");
      await narrow.screenshot({ path: narrowScreenshot, fullPage: true });
      browserResults.narrow = { viewport: narrow.viewportSize(), itemVisible: await narrow.getByText("Real material decision", { exact: true }).isVisible().catch(() => false), screenshot: basename(narrowScreenshot) };
      await narrow.close();
      await page.close();
      await context.close();
    } finally { await browser.close(); }
    const approved = await queryIssueWorkflow(config, started.workflowId);
    expect(approved.phase).toBe("ready_for_development");
    expect(attention.list("real-admin").flatMap((company) => company.attention).some((candidate) => candidate.id === item!.id)).toBe(false);

    const beforeRebuild = stableOverview(attention.list("real-admin"));
    database.authTransaction((db) => {
      db.prepare("DELETE FROM forge_attention_items WHERE company_id = 'real-company'").run();
      db.prepare("DELETE FROM forge_issue_projections WHERE company_id = 'real-company'").run();
    });
    const rebuildResponse = await api.app.inject({ method: "POST", url: "/api/admin/rebuild-projections", payload: {}, headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`, origin: config.reachableAddress, "x-csrf-v1": csrfToken } });
    expect(rebuildResponse.statusCode).toBe(200);
    expect(rebuildResponse.json()).toMatchObject({ source: "temporal" });
    expect(stableOverview(attention.list("real-admin"))).toEqual(beforeRebuild);
    expect(attention.list("real-admin")[0]?.projectionHealth.status).toBe("current");
    await mkdir(resolve(".scratch/forge-mvp/receipts"), { recursive: true });
    const observedProfile = database.authQuery((db) => db.prepare("SELECT provider, model FROM forge_profiles WHERE id = 'real-profile'").get() as { provider: string; model: string });
    await (await import("node:fs/promises")).writeFile(resolve(".scratch/forge-mvp/receipts/attention-real.json"), JSON.stringify({ companyId: "real-company", issueId: "real-decision", sourceRevision: item!.sourceRevision, projectedRevision: approved.revision, attentionId: item!.id, category: item!.category, actions: item!.actions.map((action) => action.command), beforeAttentionCount: beforeDecision[0]?.attentionCount ?? 0, afterAttentionCount: attention.list("real-admin")[0]?.attentionCount ?? 0, rebuildEqual: true, simultaneousWorkflowCount: 2, observed: { codex: { provider: observedProfile.provider, model: observedProfile.model, operation: "runLeadPlanning" }, github: { operation: "checkAuthentication/getRepository/listChecks", repository: repository.nameWithOwner, checksObserved: githubChecks.length }, browser: browserResults } }, null, 2));
  } finally {
    worker?.shutdown();
    await workerRun?.catch(() => undefined);
    await workerConnection?.close();
    await api?.app.close().catch(() => undefined);
    database?.close();
    temporalProcess?.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
}, 900_000);
