import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import type { ForgeConfig } from "./config.js";
import { ForgeDatabase } from "./database.js";
import { AcceptedProjectRevisionSchema, AuthorizedPlanSubjectSchema, DeveloperContextSchema, EvidenceManifestSchema, normalizeRepositoryInstructionPath, type AuthorizedPlanSubject, type EvidenceManifest } from "./developer-contracts.js";
import { fallbackGitPresentation, GitPresentationSchema, type GitPresentation } from "./git-presentation.js";

const execFileAsync = promisify(execFile);

export class DeveloperEvidenceFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeveloperEvidenceFailure";
    this.code = code;
  }
}

interface ArtifactRow { id: string; company_id: string; kind: string; filename: string; storage_path: string; sha256: string; byte_size: number }

function hashPolicy(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value, Object.keys(value).sort())).digest("hex");
}

function safeWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function planSteps(plan: Record<string, unknown>): Array<{ number: number; verificationCommands: string[] }> {
  if (!Array.isArray(plan.steps)) throw new DeveloperEvidenceFailure("legacy-plan-not-authorized", "The final plan does not contain numbered steps");
  return plan.steps.map((step) => {
    const record = step as Record<string, unknown>;
    if (typeof record.number !== "number" || !Array.isArray(record.verificationCommands)) throw new DeveloperEvidenceFailure("legacy-plan-not-authorized", "The final plan lacks explicit Developer verification commands");
    return { number: record.number, verificationCommands: record.verificationCommands.filter((command): command is string => typeof command === "string") };
  });
}

export interface DeveloperEvidenceBuildInput {
  subject: AuthorizedPlanSubject;
  executionId: string;
}

export interface StagedDeveloperEvidence {
  directory: string;
  relativePaths: string[];
  imagePaths: string[];
}

export class DeveloperEvidenceBuilder {
  private readonly artifacts: ArtifactStore;

  constructor(private readonly database: ForgeDatabase, private readonly config: ForgeConfig) {
    this.artifacts = new ArtifactStore(config.artifactRoot);
  }

  async build(rawSubject: DeveloperEvidenceBuildInput): Promise<{ manifest: EvidenceManifest; artifact: StoredArtifact; gitPresentation: GitPresentation }> {
    const subject = AuthorizedPlanSubjectSchema.parse(rawSubject.subject);
    const row = this.database.authQuery((db) => db.prepare(`SELECT a.id, a.company_id, a.kind, a.filename, a.storage_path, a.sha256, a.byte_size, t.title, t.brief_artifact_id, t.image_artifact_ids_json, r.id AS project_revision_id, r.normalized_json, r.base_sha, r.target_sha, r.state, p.repository_identity, p.repository_path, p.worktree_root, p.base_branch, p.target_branch, p.setup_command, p.verification_command, p.required_checks_json
      FROM forge_plan_authorizations pa
      JOIN forge_tasks t ON t.id = pa.task_id AND t.company_id = pa.company_id AND t.project_id = pa.project_id AND t.workflow_id = pa.workflow_id
      JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.state = 'accepted'
      JOIN forge_projects p ON p.id = r.project_id AND p.company_id = t.company_id
      JOIN forge_artifacts a ON a.id = pa.plan_artifact_id AND a.company_id = pa.company_id
      WHERE pa.id = ? AND pa.task_id = ? AND pa.company_id = ? AND pa.project_id = ? AND pa.workflow_id = ? AND pa.plan_revision = ? AND pa.plan_sha256 = ?`).get(subject.authorizationId, subject.taskId, subject.companyId, subject.projectId, subject.workflowId, subject.planRevision, subject.planSha256) as (ArtifactRow & { title: string; brief_artifact_id: string; image_artifact_ids_json: string; project_revision_id: string; normalized_json: string; base_sha: string; target_sha: string; state: string; repository_identity: string; repository_path: string; worktree_root: string; base_branch: string; target_branch: string; setup_command: string; verification_command: string; required_checks_json: string }) | undefined);
    if (!row) throw new DeveloperEvidenceFailure("plan-authorization-mismatch", "The authorized final plan is unavailable for this issue");
    const planBytes = await this.artifacts.read({ companyId: subject.companyId, storagePath: row.storage_path, sha256: row.sha256 });
    if (createHash("sha256").update(planBytes).digest("hex") !== subject.planSha256) throw new DeveloperEvidenceFailure("plan-authorization-mismatch", "The authorized plan artifact hash does not match");
    let plan: Record<string, unknown>;
    try { plan = JSON.parse(planBytes.toString("utf8")) as Record<string, unknown>; } catch { throw new DeveloperEvidenceFailure("legacy-plan-not-authorized", "The authorized plan is not valid JSON"); }
    let gitPresentation: GitPresentation;
    if (plan.gitPresentation === undefined || plan.gitPresentation === null) gitPresentation = fallbackGitPresentation(row.title);
    else {
      const parsed = GitPresentationSchema.safeParse(plan.gitPresentation);
      if (!parsed.success) throw new DeveloperEvidenceFailure("plan-authorization-mismatch", "The authorized plan contains invalid Git presentation metadata");
      gitPresentation = parsed.data;
    }
    const contextResult = DeveloperContextSchema.safeParse(plan.developerContext);
    if (!contextResult.success) throw new DeveloperEvidenceFailure("legacy-plan-not-authorized", "Legacy or incomplete final plans cannot authorize Developer context");
    const projectRevision = AcceptedProjectRevisionSchema.parse({
      projectRevisionId: row.project_revision_id,
      projectId: subject.projectId,
      companyId: subject.companyId,
      repositoryIdentity: row.repository_identity,
      repositoryPath: row.repository_path,
      worktreeRoot: row.worktree_root,
      baseBranch: row.base_branch,
      targetBranch: row.target_branch,
      baseSha: row.base_sha,
      targetSha: row.target_sha,
      setupVerificationPolicySha256: hashPolicy({ setupCommand: row.setup_command, verificationCommand: row.verification_command, requiredChecks: JSON.parse(row.required_checks_json) }),
    });
    if (projectRevision.projectId !== subject.projectId || row.project_revision_id !== projectRevision.projectRevisionId) throw new DeveloperEvidenceFailure("plan-authorization-mismatch", "The accepted project revision is not scoped to the issue");
    const steps = planSteps(plan);
    const allStepNumbers = steps.map((step) => step.number);
    if (new Set(allStepNumbers).size !== allStepNumbers.length) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "The final plan contains duplicate step numbers");
    const referencedSteps = (artifactIdOrPath: string, required: boolean): number[] => {
      const mapped = contextResult.data.artifactStepNumbers[artifactIdOrPath];
      if (!mapped?.length) {
        if (required) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "Developer evidence is not explicitly referenced by a plan step");
        return allStepNumbers;
      }
      if (mapped.some((stepNumber) => !allStepNumbers.includes(stepNumber))) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "Developer evidence references an unauthorized plan step");
      return mapped;
    };
    const entries: EvidenceManifest["entries"] = [{ kind: "final_plan", artifactId: row.id, repositoryPath: null, sha256: row.sha256, byteSize: planBytes.length, stagedFilename: "final-plan.json", planStepNumbers: allStepNumbers }];
    const addArtifact = async (artifact: ArtifactRow, kind: "task_brief" | "evidence" | "image", stepsForEntry: number[]) => {
      const bytes = await this.artifacts.read({ companyId: subject.companyId, storagePath: artifact.storage_path, sha256: artifact.sha256 });
      entries.push({ kind, artifactId: artifact.id, repositoryPath: null, sha256: artifact.sha256, byteSize: bytes.length, stagedFilename: `${kind}-${artifact.id}.bin`, planStepNumbers: stepsForEntry });
    };
    if (contextResult.data.includeTaskBrief) {
      const brief = this.database.authQuery((db) => db.prepare("SELECT id, company_id, kind, filename, storage_path, sha256, byte_size FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-brief'").get(row.brief_artifact_id, subject.companyId) as ArtifactRow | undefined);
      if (!brief) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "The task brief is unavailable in the issue company");
      await addArtifact(brief, "task_brief", allStepNumbers);
    }
    for (const artifactId of contextResult.data.evidenceArtifactIds) {
      const artifact = this.database.authQuery((db) => db.prepare(`SELECT a.id, a.company_id, a.kind, a.filename, a.storage_path, a.sha256, a.byte_size
        FROM forge_artifacts a
        WHERE a.id = ? AND a.company_id = ? AND a.kind = 'supplemental-review'
          AND EXISTS (SELECT 1 FROM forge_issue_governance g
            WHERE g.task_id = ? AND g.company_id = ? AND g.plan_revision = ?
              AND g.supplemental_review_used = 1 AND g.supplemental_review_artifact_id = a.id)`).get(artifactId, subject.companyId, subject.taskId, subject.companyId, subject.planRevision) as ArtifactRow | undefined);
      if (!artifact) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "The selected artifact was not available to the Lead that authored this final plan");
      await addArtifact(artifact, "evidence", referencedSteps(artifactId, true));
    }
    const taskImageIds = new Set(JSON.parse(row.image_artifact_ids_json) as string[]);
    for (const artifactId of contextResult.data.imageArtifactIds) {
      if (!taskImageIds.has(artifactId)) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "Developer image evidence is not attached to this issue");
      const artifact = this.database.authQuery((db) => db.prepare("SELECT id, company_id, kind, filename, storage_path, sha256, byte_size FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-image'").get(artifactId, subject.companyId) as ArtifactRow | undefined);
      if (!artifact) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "Developer image evidence is unavailable");
      await addArtifact(artifact, "image", referencedSteps(artifactId, true));
    }
    const repositoryPath = resolve(projectRevision.repositoryPath);
    const worktreeRoot = resolve(projectRevision.worktreeRoot);
    if (!safeWithin(this.config.repositoryRoot, repositoryPath) || !safeWithin(this.config.worktreeRoot, worktreeRoot)) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "The accepted project paths are outside Forge roots");
    for (const [index, rawPath] of contextResult.data.repositoryInstructionPaths.entries()) {
      const repositoryPathEntry = normalizeRepositoryInstructionPath(rawPath);
      const result = await execFileAsync("git", ["show", `${projectRevision.targetSha}:${repositoryPathEntry}`], { cwd: repositoryPath, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      const bytes = Buffer.from(result.stdout, "utf8");
      entries.push({ kind: "repository_instruction", artifactId: null, repositoryPath: repositoryPathEntry, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, stagedFilename: `repository-instruction-${index + 1}.txt`, planStepNumbers: referencedSteps(repositoryPathEntry, false) });
    }
    const manifest = EvidenceManifestSchema.parse({ version: 1, authorizedPlan: subject, projectRevision, entries, contradictionRule: "stop_before_unrelated_edits", verificationCommands: steps.map((step) => ({ stepNumber: step.number, commands: step.verificationCommands })), createdAt: subject.authorizedAt });
    const artifact = await this.artifacts.put(subject.companyId, "developer-evidence-manifest", { filename: `${rawSubject.executionId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });
    this.database.authTransaction((db) => db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt));
    return { manifest, artifact, gitPresentation };
  }

  async stage(manifest: EvidenceManifest, worktreePath: string, executionId: string): Promise<StagedDeveloperEvidence> {
    const canonicalWorktree = await realpath(worktreePath);
    const directory = resolve(canonicalWorktree, ".forge-context", executionId);
    const parent = resolve(canonicalWorktree, ".forge-context");
    const ignorePath = resolve(parent, ".gitignore");
    const existing = await lstat(directory).catch(() => undefined);
    if (existing && !existing.isDirectory()) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "The staged Developer context path is not a directory");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const ignore = await readFile(ignorePath, "utf8").catch(() => undefined);
    if (ignore !== undefined && ignore !== "*\n") throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "The staged Developer context ignore boundary is not owned by Forge");
    if (ignore === undefined) await writeFile(ignorePath, "*\n", { encoding: "utf8", mode: 0o400, flag: "wx" });
    await chmod(ignorePath, 0o400);
    const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const manifestMarker = resolve(directory, ".manifest.sha256");
    const existingMarker = await readFile(manifestMarker, "utf8").catch(() => undefined);
    if (existingMarker !== undefined && existingMarker.trim() !== manifestSha256) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "The existing staged Developer context belongs to a different immutable manifest");
    if (existing && existingMarker === undefined) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "The existing staged Developer context has no immutable manifest identity");
    if (existingMarker === undefined) await writeFile(manifestMarker, `${manifestSha256}\n`, { encoding: "utf8", mode: 0o400, flag: "wx" });
    const relativePaths: string[] = [];
    const imagePaths: string[] = [];
    for (const entry of manifest.entries) {
      const bytes = entry.artifactId
        ? await this.readArtifactById(manifest.authorizedPlan.companyId, entry.artifactId, entry.sha256)
        : Buffer.from((await execFileAsync("git", ["show", `${manifest.projectRevision.targetSha}:${entry.repositoryPath!}`], { cwd: manifest.projectRevision.repositoryPath, maxBuffer: 8 * 1024 * 1024 })).stdout, "utf8");
      if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "Staged evidence bytes do not match the immutable manifest");
      const path = resolve(directory, entry.stagedFilename);
      if (!safeWithin(directory, path)) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "Staged evidence escaped the execution directory");
      if (existingMarker !== undefined) {
        const staged = await readFile(path).catch(() => undefined);
        if (!staged || !staged.equals(bytes)) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "The existing staged Developer context does not match its immutable manifest");
      } else await writeFile(path, bytes, { encoding: "utf8", mode: 0o400 });
      relativePaths.push(`.forge-context/${executionId}/${entry.stagedFilename}`);
      if (entry.kind === "image") imagePaths.push(path);
    }
    await chmod(parent, 0o700);
    return { directory, relativePaths, imagePaths };
  }

  async cleanup(worktreePath: string, executionId: string): Promise<void> {
    const canonical = await realpath(worktreePath);
    const directory = resolve(canonical, ".forge-context", executionId);
    if (!safeWithin(resolve(canonical, ".forge-context"), directory) || directory === canonical) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "Refusing to remove an unsafe staged context path");
    await rm(directory, { recursive: true, force: true });
    const parent = resolve(canonical, ".forge-context");
    const entries = await readdir(parent).catch(() => []);
    if (entries.length === 1 && entries[0] === ".gitignore" && await readFile(resolve(parent, ".gitignore"), "utf8").catch(() => "") === "*\n") {
      await rm(resolve(parent, ".gitignore"), { force: true });
      await rmdir(parent).catch(() => undefined);
    }
  }

  private async readArtifactById(companyId: string, artifactId: string, expectedSha256: string): Promise<Buffer> {
    const row = this.database.authQuery((db) => db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(artifactId, companyId) as { storage_path: string; sha256: string } | undefined);
    if (!row || row.sha256 !== expectedSha256) throw new DeveloperEvidenceFailure("evidence-manifest-invalid", "Manifest artifact identity does not match the company-scoped artifact");
    return this.artifacts.read({ companyId, storagePath: row.storage_path, sha256: row.sha256 });
  }
}
