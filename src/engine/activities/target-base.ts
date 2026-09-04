import type { TargetBaseActivities } from "../contracts/activities/target-base.js";
import type { ReconcileTargetBaseActivityInput, ReconcileTargetBaseActivityResult, TargetBaseBlockerCode } from "../contracts/primitives.js";
import type { ActivityContext } from "./context.js";
import { join } from "node:path";
import { loadTaskConfiguration } from "../../task-project-configuration.js";
import { proveForwardMergeLineage, type ForwardMergeLineageProof } from "./forward-merge-lineage.js";
import { proveRevisionInGit } from "./git-proof.js";
import { isTaskTurnLive } from "./herdr-liveness.js";
import { runCommand } from "../../command-runner.js";
import { json } from "../../task-utils.js";

type VerificationBlockerCode = Extract<TargetBaseBlockerCode, "verification_failed" | "verification_timed_out" | "verification_evidence_too_large">;
type DeliveryArtifactKind = "developer-delivery" | "forward-merge-delivery";
const deliveryArtifactKinds: readonly DeliveryArtifactKind[] = ["developer-delivery", "forward-merge-delivery"];
function isDeliveryArtifactKind(kind: string | null | undefined): kind is DeliveryArtifactKind { return deliveryArtifactKinds.includes(kind as DeliveryArtifactKind); }
const verificationBlockerCodes: readonly VerificationBlockerCode[] = ["verification_failed", "verification_timed_out", "verification_evidence_too_large"];
function isVerificationBlockerCode(code: string | null): code is VerificationBlockerCode {
  return verificationBlockerCodes.some((candidate) => candidate === code);
}

type NoDriftMergedDelivery = {
  id: string;
  projectRevisionId: string | null;
  expectedBaseSha: string;
  targetBaseSha: string;
  priorHead: string;
  priorTree: string | null;
  mergeCommit: string | null;
  tree: string | null;
  resultHead: string | null;
  resultTree: string | null;
  developerExecutionId: string | null;
  verificationArtifactId: string | null;
  deliveryArtifactId: string | null;
  failureCode: string | null;
  failureSummary: string | null;
};

type DeveloperDeliveryContext = {
  developerExecutionId: string;
  developerStatus: string;
  developerSessionRef: string | null;
  branchName: string;
  worktreePath: string;
  targetBaseSha: string;
  resultCommit: string | null;
  resultTree: string | null;
  planRevision: number;
  deliveryArtifactId: string | null;
  deliveryArtifactKind: string | null;
  deliveryArtifactSha256: string | null;
  evidenceArtifactId: string | null;
};

type BaseVerificationOutcome = {
  sha: string;
  outcome: "passed" | "failed" | "unknown";
  summary: string;
};

type ForwardMergeVerificationPayload = {
  outcome: "passed" | "failed";
  code?: VerificationBlockerCode;
  summary: string;
  commands: unknown[];
  base?: BaseVerificationOutcome;
};

function sameRevision(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function baseVerificationOutcome(raw: unknown, sha: string): BaseVerificationOutcome | undefined {
  if (!raw || typeof raw !== "object" || !("base" in raw)) return undefined;
  const base = raw.base;
  if (!base || typeof base !== "object" || !("sha" in base) || !("outcome" in base) || !("summary" in base)) return undefined;
  if (typeof base.sha !== "string" || !sameRevision(base.sha, sha) || typeof base.summary !== "string") return undefined;
  if (base.outcome !== "passed" && base.outcome !== "failed" && base.outcome !== "unknown") return undefined;
  return { sha: base.sha, outcome: base.outcome, summary: base.summary };
}

export function createTargetBaseActivities(ctx: ActivityContext): TargetBaseActivities {
  const { database, config, randomBytes, ArtifactStore, ForwardMergeFailure, ForwardMergeService, runPinnedVerification, createGitCommandGuard, ReconcileTargetBaseActivityInputSchema, normalizeSafeSummary, githubRelease, artifactReference, reconcileBlocker } = ctx;
  return {
    async reconcileTargetBase(rawInput: ReconcileTargetBaseActivityInput): Promise<ReconcileTargetBaseActivityResult> {
      const input = ReconcileTargetBaseActivityInputSchema.parse(rawInput);
      const checkId = `target_base_${randomBytes(12).toString("hex")}`;
      const liveTurn = await isTaskTurnLive(database, config, input.taskId);
      if (liveTurn.live) {
        return {
          outcome: "blocked",
          checkId,
          checkpoint: input.checkpoint,
          code: "provider_unavailable",
          owner: "lead",
          retryable: true,
          summary: "A Builder turn is still running. Forge checks again when it finishes.",
        };
      }
      const requestedForwardMergeId = input.verificationOnly ? input.forwardMergeId : undefined;
      const recordedExecutionId = requestedForwardMergeId
        ? (database.authQuery((db) => db.prepare(`SELECT developer_execution_id AS developerExecutionId FROM forge_forward_merges
            WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND project_revision_id = ? AND checkpoint = ?
              AND result_head = ? AND result_tree = ?`).get(requestedForwardMergeId, input.taskId, input.companyId, input.workflowId, input.projectRevisionId, input.checkpoint, input.expectedHeadSha, input.expectedHeadTree) as { developerExecutionId: string | null } | undefined)?.developerExecutionId)
        : undefined;
      const developerExecutionId = recordedExecutionId ?? input.developerExecutionId;
      const contextQuery = `SELECT
          d.id AS developerExecutionId, d.status AS developerStatus, d.session_ref AS developerSessionRef,
          d.branch_name AS branchName, d.worktree_path AS worktreePath, d.target_base_sha AS targetBaseSha,
          d.result_commit AS resultCommit, d.result_tree AS resultTree, d.plan_revision AS planRevision,
          d.delivery_artifact_id AS deliveryArtifactId, da.kind AS deliveryArtifactKind, da.sha256 AS deliveryArtifactSha256,
          d.evidence_artifact_id AS evidenceArtifactId
        FROM forge_tasks t
        JOIN forge_developer_executions d ON d.task_id = t.id AND d.company_id = t.company_id AND d.workflow_id = t.workflow_id
        LEFT JOIN forge_artifacts da ON da.id = d.delivery_artifact_id AND da.company_id = d.company_id AND da.kind IN ('developer-delivery', 'forward-merge-delivery')
        WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ?`;
      const recordedContext = database.authQuery((db) => db.prepare(`${contextQuery} AND d.id = ?`).get(input.taskId, input.companyId, input.workflowId, developerExecutionId) as DeveloperDeliveryContext | undefined);
      const fallbackContext = database.authQuery((db) => db.prepare(`${contextQuery}
            AND d.status IN ('completed', 'blocked') AND d.session_ref IS NOT NULL
            ORDER BY CASE WHEN lower(d.result_commit) = lower(?) THEN 0 ELSE 1 END, d.finished_at DESC
            LIMIT 1`).get(input.taskId, input.companyId, input.workflowId, input.expectedHeadSha) as DeveloperDeliveryContext | undefined);
      const recordedRevisionContext = database.authQuery((db) => db.prepare(`${contextQuery}
            AND lower(d.result_commit) = lower(?) AND lower(d.result_tree) = lower(?)
            ORDER BY d.finished_at DESC LIMIT 1`).get(input.taskId, input.companyId, input.workflowId, input.expectedHeadSha, input.expectedHeadTree) as DeveloperDeliveryContext | undefined);
      let context = recordedContext && ["completed", "blocked"].includes(recordedContext.developerStatus)
        ? recordedContext
        : fallbackContext ?? recordedRevisionContext;
      const blocked = (code: TargetBaseBlockerCode, owner: "human" | "provider" | "lead", retryable: boolean, summary: string, evidenceArtifact?: ReturnType<typeof artifactReference>, coordinates?: { observedBaseSha?: string; priorHead?: string; priorTree?: string; resultHead?: string; resultTree?: string }, operationId = requestedForwardMergeId ?? checkId): ReconcileTargetBaseActivityResult => ({ outcome: "blocked", checkId: operationId, checkpoint: input.checkpoint, code, owner, retryable, summary: normalizeSafeSummary(summary, 200), ...(evidenceArtifact ? { evidenceArtifact } : {}), ...(coordinates ?? {}) });
      const adoptStoredDelivery = (delivery: { developerExecutionId: string; priorHead: string; priorTree: string; resultHead: string; resultTree: string }): boolean => database.authTransaction((db) => {
        const updated = db.prepare(`UPDATE forge_developer_executions SET result_commit = ?, result_tree = ?
          WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND status = 'completed'
            AND lower(result_commit) = lower(?) AND lower(result_tree) = lower(?)`).run(delivery.resultHead, delivery.resultTree, delivery.developerExecutionId, input.taskId, input.companyId, input.workflowId, delivery.priorHead, delivery.priorTree).changes;
        if (updated === 1) return true;
        return db.prepare(`SELECT 1 FROM forge_developer_executions
          WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND status = 'completed'
            AND lower(result_commit) = lower(?) AND lower(result_tree) = lower(?)`).get(delivery.developerExecutionId, input.taskId, input.companyId, input.workflowId, delivery.resultHead, delivery.resultTree) !== undefined;
      });
      const artifacts = new ArtifactStore(config.artifactRoot, database);
      let pinned: ReturnType<typeof loadTaskConfiguration>;
      try { pinned = database.authQuery((db) => loadTaskConfiguration(db, artifacts, input)); } catch { return blocked("artifact_unavailable", "human", false, "The task project configuration is unavailable or incomplete"); }
      if (!context || !["completed", "blocked"].includes(context.developerStatus) || !context.resultCommit || !context.resultTree) {
        const worktree = context ?? database.authQuery((db) => db.prepare(`SELECT branch_name AS branchName, worktree_path AS worktreePath
          FROM forge_issue_worktrees WHERE task_id = ? AND company_id = ? AND workflow_id = ? ORDER BY reserved_at DESC LIMIT 1`).get(input.taskId, input.companyId, input.workflowId) as { branchName: string; worktreePath: string } | undefined);
        if (!worktree) return blocked("merge_state_ownership_mismatch", "human", true, "Git could not find the task worktree for reconciliation.");
        const proof = await proveRevisionInGit(githubRelease, { worktreePath: worktree.worktreePath, branchName: worktree.branchName, commit: input.expectedHeadSha, tree: input.expectedHeadTree, baseSha: input.expectedBaseSha });
        if (!proof.proven) return blocked("merge_state_ownership_mismatch", "human", true, "Git could not prove the reviewed delivery in the task worktree.");
        context = {
          developerExecutionId: context?.developerExecutionId ?? developerExecutionId,
          developerStatus: "completed",
          developerSessionRef: context?.developerSessionRef ?? null,
          branchName: worktree.branchName,
          worktreePath: worktree.worktreePath,
          targetBaseSha: input.expectedBaseSha,
          resultCommit: input.expectedHeadSha,
          resultTree: input.expectedHeadTree,
          planRevision: context?.planRevision ?? 1,
          deliveryArtifactId: context?.deliveryArtifactId ?? null,
          deliveryArtifactKind: context?.deliveryArtifactKind ?? null,
          deliveryArtifactSha256: context?.deliveryArtifactSha256 ?? null,
          evidenceArtifactId: context?.evidenceArtifactId ?? null,
        };
      }
      const service = new ForwardMergeService(database, githubRelease, artifacts);
      const previousBaseVerification = async (baseSha: string): Promise<BaseVerificationOutcome | undefined> => {
        const rows = database.authQuery((db) => db.prepare(`SELECT storage_path AS storagePath, sha256
          FROM forge_artifacts WHERE company_id = ? AND task_id = ? AND kind = 'forward-merge-verification'
          ORDER BY created_at DESC`).all(input.companyId, input.taskId) as Array<{ storagePath: string; sha256: string }>);
        for (const row of rows) {
          try {
            const payload = json((await artifacts.getArtifact({ companyId: input.companyId, storagePath: row.storagePath, sha256: row.sha256 })).toString("utf8"), undefined);
            const outcome = baseVerificationOutcome(payload, baseSha);
            if (outcome) return outcome;
          } catch {
            continue;
          }
        }
        return undefined;
      };
      const verifyBase = async (baseSha: string, guard: Awaited<ReturnType<typeof createGitCommandGuard>>): Promise<BaseVerificationOutcome> => {
        const reused = await previousBaseVerification(baseSha);
        if (reused) return reused;
        const worktreePath = join(config.runtimeRoot, `${checkId}-base`);
        const added = await runCommand({ taskId: input.taskId, stepId: checkId, command: "git", args: ["worktree", "add", "--detach", worktreePath, baseSha], cwd: pinned.repositoryPath, timeout: 60_000 });
        if (added.exitCode !== 0 || added.timedOut) return { sha: baseSha, outcome: "unknown", summary: "The base branch verification worktree could not be created." };
        try {
          const result = await runPinnedVerification({ taskId: input.taskId, stepId: checkId, worktreePath, setupCommand: pinned.setupCommand, verificationCommand: pinned.verificationCommand, runtimeRoot: config.runtimeRoot }, { guard });
          if (result.code === "verification_timed_out") return { sha: baseSha, outcome: "unknown", summary: result.summary };
          return { sha: baseSha, outcome: result.outcome === "passed" ? "passed" : "failed", summary: result.summary };
        } finally {
          await runCommand({ taskId: input.taskId, stepId: checkId, command: "git", args: ["worktree", "remove", "--force", worktreePath], cwd: pinned.repositoryPath, timeout: 60_000 });
        }
      };
      const adoptObservedTaskBranch = async (): Promise<ReconcileTargetBaseActivityResult | undefined> => {
        const priorHead = context.resultCommit!;
        const priorTree = context.resultTree!;
        const observed = await service.observeCleanTaskBranch({ worktreePath: context.worktreePath, repositoryPath: pinned.repositoryPath, branchName: context.branchName });
        if (sameRevision(observed.headSha, priorHead) && sameRevision(observed.treeSha, priorTree)) return undefined;
        const guard = await createGitCommandGuard(config.runtimeRoot);
        try {
          const verification = await runPinnedVerification({ taskId: input.taskId, stepId: checkId, worktreePath: context.worktreePath, setupCommand: pinned.setupCommand, verificationCommand: pinned.verificationCommand, runtimeRoot: config.runtimeRoot }, { guard });
          const verificationArtifact = await artifacts.putArtifact(input.companyId, "forward-merge-verification", { filename: `${checkId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(verification), "utf8") });
          if (verification.outcome !== "passed") {
            return blocked(verification.code === "verification_timed_out" ? "verification_timed_out" : verification.code === "verification_evidence_too_large" ? "verification_evidence_too_large" : "verification_failed", "lead", true, verification.summary, artifactReference(verificationArtifact), { observedBaseSha: input.expectedBaseSha, priorHead, priorTree, resultHead: observed.headSha, resultTree: observed.treeSha });
          }
          const deliveryArtifact = await artifacts.putArtifact(input.companyId, "forward-merge-delivery", { filename: `${checkId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ version: 1, kind: "observed-task-branch", summary: "Observed clean task branch adopted; prior delivery evidence is diagnostic only", priorHead, priorTree, resultCommit: observed.headSha, resultTree: observed.treeSha, developerExecutionId: context.developerExecutionId, verificationArtifactId: verificationArtifact.id }, null, 2), "utf8") });
          const adopted = database.authTransaction((db) => db.prepare(`UPDATE forge_developer_executions
              SET status = 'completed', result_commit = ?, result_tree = ?, dirty_state = 'clean', delivery_artifact_id = ?, evidence_artifact_id = ?
              WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?
                AND status IN ('completed', 'blocked') AND lower(result_commit) = lower(?) AND lower(result_tree) = lower(?)`).run(observed.headSha, observed.treeSha, deliveryArtifact.id, verificationArtifact.id, context.developerExecutionId, input.taskId, input.companyId, input.workflowId, priorHead, priorTree).changes);
          if (adopted !== 1) return undefined;
          return { outcome: "revalidated", checkId, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: input.expectedBaseSha, priorHead, priorTree, headSha: observed.headSha, headTree: observed.treeSha, developerExecutionId: context.developerExecutionId, deliveryArtifact: artifactReference({ id: deliveryArtifact.id, kind: "forward-merge-delivery" }), verificationArtifact: artifactReference({ id: verificationArtifact.id, kind: "forward-merge-verification" }) };
        } finally { await guard.cleanup(); }
      };
      let merge;
      try {
        if (input.verificationOnly) {
          if (!input.forwardMergeId) return blocked("merge_state_ownership_mismatch", "human", true, "The recorded forward-merge identity is unavailable");
          merge = await service.revalidateMergedOperation({ forwardMergeId: input.forwardMergeId, worktreePath: context.worktreePath, repositoryPath: pinned.repositoryPath, branchName: context.branchName, expectedBaseSha: input.expectedBaseSha, expectedHeadSha: input.expectedHeadSha, expectedHeadTree: input.expectedHeadTree, taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, projectRevisionId: pinned.artifactId, checkpoint: input.checkpoint, developerExecutionId });
        } else {
          merge = await service.reconcile({ worktreePath: context.worktreePath, repositoryPath: pinned.repositoryPath, branchName: context.branchName, expectedBaseSha: input.expectedBaseSha, expectedHeadSha: input.expectedHeadSha, expectedHeadTree: input.expectedHeadTree, repository: pinned.repository, baseBranch: pinned.baseBranch, taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, projectRevisionId: pinned.artifactId, checkpoint: input.checkpoint, developerExecutionId, ...(input.releaseId ? { releaseId: input.releaseId } : {}), ...(input.deliveryReviewId ? { deliveryReviewId: input.deliveryReviewId } : {}), ...(input.ciRunId ? { ciRunId: input.ciRunId } : {}), ...(input.finalReviewId ? { finalReviewId: input.finalReviewId } : {}), ...(input.acceptanceId ? { acceptanceId: input.acceptanceId } : {}) });
        }
      } catch (error) {
        if (error instanceof ForwardMergeFailure && error.code === "merge-state-ownership-mismatch") {
          try {
            const adopted = await adoptObservedTaskBranch();
            if (adopted) return adopted;
          } catch (adoptionError) {
            const failure = reconcileBlocker(adoptionError);
            return blocked(failure.code, failure.owner, failure.retryable, failure.summary);
          }
        }
        const failure = reconcileBlocker(error);
        return blocked(failure.code, failure.owner, failure.retryable, failure.summary);
      }
      if (merge.status === "conflict") {
        if (merge.conflictEvidenceTooLarge || !merge.conflictArtifact) return blocked("conflict_evidence_too_large", "lead", false, "Conflict evidence exceeded the safe artifact limit", undefined, { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree }, merge.forwardMergeId ?? checkId);
        return { outcome: "conflict", checkId: merge.forwardMergeId ?? checkId, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, conflictFileCount: merge.conflictFiles.length, conflictArtifact: artifactReference(merge.conflictArtifact) };
      }
      const storedMergeId = input.verificationOnly ? input.forwardMergeId : merge.forwardMergeId;
      const storedDelivery = storedMergeId ? database.authQuery((db) => db.prepare(`SELECT m.developer_execution_id AS developerExecutionId, d.evidence_artifact_id AS developerEvidenceArtifactId, m.expected_base_sha AS expectedBaseSha, m.result_head AS resultHead, m.result_tree AS resultTree, m.verification_artifact_id AS verificationArtifactId, m.delivery_artifact_id AS deliveryArtifactId, m.failure_code AS failureCode, m.failure_summary AS failureSummary FROM forge_forward_merges m LEFT JOIN forge_developer_executions d ON d.id = m.developer_execution_id AND d.task_id = m.task_id AND d.company_id = m.company_id AND d.workflow_id = m.workflow_id WHERE m.id = ? AND m.task_id = ? AND m.company_id = ? AND m.workflow_id = ? AND m.project_revision_id = ? AND m.checkpoint = ?`).get(storedMergeId, input.taskId, input.companyId, input.workflowId, input.projectRevisionId, input.checkpoint) as { developerExecutionId: string | null; developerEvidenceArtifactId: string | null; expectedBaseSha: string; resultHead: string | null; resultTree: string | null; verificationArtifactId: string | null; deliveryArtifactId: string | null; failureCode: string | null; failureSummary: string | null } | undefined) : undefined;
      const storedArtifacts = storedDelivery && (storedDelivery.verificationArtifactId || storedDelivery.deliveryArtifactId)
        ? database.authQuery((db) => db.prepare("SELECT id, kind FROM forge_artifacts WHERE company_id = ? AND (id = ? OR id = ?) ORDER BY id").all(input.companyId, storedDelivery.verificationArtifactId, storedDelivery.deliveryArtifactId) as Array<{ id: string; kind: string }>)
        : [];
      const verificationArtifact = storedDelivery ? storedArtifacts.find((artifact) => artifact.id === storedDelivery.verificationArtifactId && artifact.kind === "forward-merge-verification") : undefined;
      const deliveryArtifact = storedDelivery ? storedArtifacts.find((artifact) => artifact.id === storedDelivery.deliveryArtifactId && isDeliveryArtifactKind(artifact.kind)) : undefined;
      const storedLineage = merge.status === "merged" && storedMergeId && storedDelivery?.developerExecutionId
        ? database.authQuery((db) => proveForwardMergeLineage(db, { currentMergeId: storedMergeId, taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, projectRevisionId: input.projectRevisionId, checkpoint: input.checkpoint, developerExecutionId: storedDelivery.developerExecutionId! }))
        : undefined;
      const storedLineageMatchesContext = !!storedLineage
        && context.developerExecutionId === storedLineage.developer.id && context.developerStatus === storedLineage.developer.status
        && sameRevision(context.targetBaseSha, storedLineage.developer.targetBaseSha)
        && sameRevision(context.resultCommit, storedLineage.developer.resultHead) && sameRevision(context.resultTree, storedLineage.developer.resultTree);
      const storedLineageMatchesMerge = storedLineageMatchesContext && !!merge.mergeCommit && !!merge.tree
        && sameRevision(storedLineage.current.currentBaseSha, merge.targetBaseSha)
        && sameRevision(storedLineage.current.priorHead, merge.priorHead) && sameRevision(storedLineage.current.priorTree, merge.priorTree)
        && sameRevision(storedLineage.current.resultHead, merge.mergeCommit) && sameRevision(storedLineage.current.resultTree, merge.tree);
      if (merge.status === "merged" && storedDelivery?.developerExecutionId && (storedDelivery.failureCode !== null || storedDelivery.failureSummary !== null)) {
        const coordinates = { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, ...(storedDelivery.resultHead ? { resultHead: storedDelivery.resultHead } : {}), ...(storedDelivery.resultTree ? { resultTree: storedDelivery.resultTree } : {}) };
        const failureCode = storedDelivery.failureCode;
        const failureSummary = storedDelivery.failureSummary;
        const ownsStoredVerificationFailure = storedLineageMatchesMerge && isVerificationBlockerCode(failureCode) && !!failureSummary;
        if (!ownsStoredVerificationFailure) return blocked("merge_state_ownership_mismatch", "human", true, "The blocked Developer revision does not match the recorded forward-merge verification failure", undefined, coordinates, merge.forwardMergeId ?? checkId);
        if (!verificationArtifact) return blocked("artifact_unavailable", "human", false, "The stored forward-merge verification artifact is unavailable", undefined, coordinates, merge.forwardMergeId ?? checkId);
        return blocked(failureCode, "lead", true, failureSummary, artifactReference({ id: verificationArtifact.id, kind: "forward-merge-verification" }), coordinates, merge.forwardMergeId ?? checkId);
      }
      if (merge.status === "merged" && storedDelivery && storedArtifacts.length === 2 && storedDelivery.developerExecutionId && storedDelivery.resultHead && storedDelivery.resultTree) {
        if (verificationArtifact && deliveryArtifact) {
          const adopted = storedLineageMatchesMerge && (storedLineage!.kind === "transitive" || adoptStoredDelivery({ developerExecutionId: storedDelivery.developerExecutionId, priorHead: merge.priorHead, priorTree: merge.priorTree, resultHead: storedDelivery.resultHead, resultTree: storedDelivery.resultTree }));
          if (!adopted) return blocked("merge_state_ownership_mismatch", "human", true, "The completed Developer revision does not match the recorded forward merge", undefined, { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, resultHead: storedDelivery.resultHead, resultTree: storedDelivery.resultTree }, merge.forwardMergeId ?? checkId);
          return { outcome: "revalidated", checkId: merge.forwardMergeId ?? checkId, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, headSha: storedDelivery.resultHead, headTree: storedDelivery.resultTree, developerExecutionId: storedDelivery.developerExecutionId, deliveryArtifact: artifactReference({ id: deliveryArtifact.id, kind: deliveryArtifact.kind as DeliveryArtifactKind }), verificationArtifact: artifactReference({ id: verificationArtifact.id, kind: "forward-merge-verification" }), ...(storedDelivery.developerEvidenceArtifactId ? { developerEvidenceArtifactId: storedDelivery.developerEvidenceArtifactId } : {}) };
        }
      }
      if (merge.status === "merged" && !storedLineageMatchesMerge) {
        try {
          const adopted = await adoptObservedTaskBranch();
          if (adopted) return adopted;
        } catch (error) {
          const failure = reconcileBlocker(error);
          return blocked(failure.code, failure.owner, failure.retryable, failure.summary);
        }
        return blocked("merge_state_ownership_mismatch", "human", true, "The Developer revision does not match the recorded forward merge", undefined, { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, ...(merge.mergeCommit ? { resultHead: merge.mergeCommit } : {}), ...(merge.tree ? { resultTree: merge.tree } : {}) }, merge.forwardMergeId ?? checkId);
      }
      if (merge.status === "no_drift") {
        const gitProof = await proveRevisionInGit(githubRelease, {
          worktreePath: context.worktreePath,
          branchName: context.branchName,
          commit: input.expectedHeadSha,
          tree: input.expectedHeadTree,
          baseSha: merge.targetBaseSha,
        });
        if (gitProof.proven) {
          const receipt = database.authQuery((db) => db.prepare(`SELECT
              m.id, m.prior_head AS priorHead, m.prior_tree AS priorTree, m.developer_execution_id AS developerExecutionId,
              m.delivery_artifact_id AS deliveryArtifactId, m.verification_artifact_id AS verificationArtifactId,
              d.evidence_artifact_id AS developerEvidenceArtifactId
            FROM forge_forward_merges m
            LEFT JOIN forge_developer_executions d ON d.id = m.developer_execution_id
              AND d.task_id = m.task_id AND d.company_id = m.company_id AND d.workflow_id = m.workflow_id
            WHERE m.task_id = ? AND m.company_id = ? AND m.workflow_id = ? AND m.status = 'merged'
              AND lower(m.result_head) = lower(?)
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT 1`).get(input.taskId, input.companyId, input.workflowId, input.expectedHeadSha) as {
              id: string;
              priorHead: string;
              priorTree: string | null;
              developerExecutionId: string | null;
              deliveryArtifactId: string | null;
              verificationArtifactId: string | null;
              developerEvidenceArtifactId: string | null;
            } | undefined);
          const receiptArtifacts = receipt && (receipt.deliveryArtifactId || receipt.verificationArtifactId)
            ? database.authQuery((db) => db.prepare("SELECT id, kind FROM forge_artifacts WHERE company_id = ? AND (id = ? OR id = ?)").all(input.companyId, receipt.deliveryArtifactId, receipt.verificationArtifactId) as Array<{ id: string; kind: string }>)
            : [];
          const receiptDeliveryArtifact = receiptArtifacts.find((artifact) => artifact.id === receipt?.deliveryArtifactId && isDeliveryArtifactKind(artifact.kind));
          let receiptVerificationArtifact = receiptArtifacts.find((artifact) => artifact.id === receipt?.verificationArtifactId && artifact.kind === "forward-merge-verification");
          if (receipt && !receiptVerificationArtifact) {
            const guard = await createGitCommandGuard(config.runtimeRoot);
            try {
              const verification = await runPinnedVerification({ taskId: input.taskId, stepId: receipt.id, worktreePath: context.worktreePath, setupCommand: pinned.setupCommand, verificationCommand: pinned.verificationCommand, runtimeRoot: config.runtimeRoot }, { guard });
              const base = verification.outcome === "passed" ? undefined : await verifyBase(merge.targetBaseSha, guard);
              const payload: ForwardMergeVerificationPayload = base?.outcome === "failed"
                ? { ...verification, summary: "The base branch does not pass verification. GitHub CI judges the pull request.", base }
                : { ...verification, ...(base ? { base } : {}) };
              const verificationArtifact = await artifacts.putArtifact(input.companyId, "forward-merge-verification", { taskId: input.taskId, filename: `${receipt.id}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(payload), "utf8") });
              database.authTransaction((db) => db.prepare("UPDATE forge_forward_merges SET verification_artifact_id = ?, verification_artifact_sha256 = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ?").run(verificationArtifact.id, verificationArtifact.sha256, new Date().toISOString(), receipt.id, input.taskId, input.companyId, input.workflowId));
              receiptVerificationArtifact = { id: verificationArtifact.id, kind: "forward-merge-verification" };
              if (verification.outcome !== "passed" && base?.outcome !== "failed") {
                return blocked(verification.code === "verification_timed_out" ? "verification_timed_out" : verification.code === "verification_evidence_too_large" ? "verification_evidence_too_large" : "verification_failed", "lead", true, verification.summary, artifactReference(receiptVerificationArtifact), { observedBaseSha: merge.targetBaseSha, priorHead: receipt.priorHead, ...(receipt.priorTree ? { priorTree: receipt.priorTree } : {}) }, receipt.id);
              }
            } finally {
              await guard.cleanup();
            }
          }
          if (receipt?.developerExecutionId && receipt.priorTree && receiptDeliveryArtifact && receiptVerificationArtifact) {
            return {
              outcome: "revalidated",
              checkId: merge.forwardMergeId ?? checkId,
              checkpoint: input.checkpoint,
              expectedBaseSha: input.expectedBaseSha,
              observedBaseSha: merge.targetBaseSha,
              priorHead: receipt.priorHead,
              priorTree: receipt.priorTree,
              headSha: gitProof.head!,
              headTree: gitProof.headTree!,
              developerExecutionId: receipt.developerExecutionId,
              deliveryArtifact: artifactReference({ id: receiptDeliveryArtifact.id, kind: receiptDeliveryArtifact.kind as DeliveryArtifactKind }),
              verificationArtifact: artifactReference({ id: receiptVerificationArtifact.id, kind: "forward-merge-verification" }),
              ...(receipt.developerEvidenceArtifactId ? { developerEvidenceArtifactId: receipt.developerEvidenceArtifactId } : {}),
            };
          }
          return { outcome: "no_drift", checkId: merge.forwardMergeId ?? checkId, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: merge.targetBaseSha, headSha: gitProof.head!, headTree: gitProof.headTree! };
        }
        if (gitProof.head !== null) {
          return blocked("merge_state_ownership_mismatch", "human", true, "Git shows a different commit on the task branch. Retry the base update.", undefined, { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree }, merge.forwardMergeId ?? checkId);
        }
        const mergedDeliveries = database.authQuery((db) => db.prepare(`SELECT
            m.id, m.project_revision_id AS projectRevisionId, m.expected_base_sha AS expectedBaseSha, m.current_base_sha AS targetBaseSha,
            m.prior_head AS priorHead, m.prior_tree AS priorTree, m.merge_commit AS mergeCommit, m.tree,
            m.result_head AS resultHead, m.result_tree AS resultTree, m.developer_execution_id AS developerExecutionId,
            m.verification_artifact_id AS verificationArtifactId, m.delivery_artifact_id AS deliveryArtifactId,
            m.failure_code AS failureCode, m.failure_summary AS failureSummary
          FROM forge_forward_merges m
          WHERE m.task_id = ? AND m.company_id = ? AND m.workflow_id = ? AND m.status = 'merged'
            AND (lower(m.result_head) = lower(?) OR lower(m.merge_commit) = lower(?))
          ORDER BY m.id`).all(input.taskId, input.companyId, input.workflowId, input.expectedHeadSha, input.expectedHeadSha) as NoDriftMergedDelivery[]);
        const provenDeliveries: Array<{ mergedDelivery: NoDriftMergedDelivery; lineage: ForwardMergeLineageProof }> = [];
        let reusedDeliveryArtifact: { id: string; kind: DeliveryArtifactKind; sha256: string } | undefined;
        let reusedVerificationArtifact: { id: string; kind: "forward-merge-verification"; sha256?: string } | undefined;
        for (const mergedDelivery of mergedDeliveries) {
          if (!mergedDelivery.developerExecutionId) continue;
          const lineage = database.authQuery((db) => proveForwardMergeLineage(db, { currentMergeId: mergedDelivery.id, taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, projectRevisionId: input.projectRevisionId, checkpoint: input.checkpoint, developerExecutionId: mergedDelivery.developerExecutionId! }));
          const ownsMergedDelivery = !!lineage
            && sameRevision(lineage.current.currentBaseSha, merge.targetBaseSha)
            && sameRevision(lineage.current.resultHead, input.expectedHeadSha) && sameRevision(lineage.current.resultTree, input.expectedHeadTree)
            && sameRevision(merge.priorHead, lineage.current.resultHead) && sameRevision(merge.priorTree, lineage.current.resultTree);
          if (lineage && ownsMergedDelivery) provenDeliveries.push({ mergedDelivery, lineage });
        }
        if (mergedDeliveries.length > 0 && provenDeliveries.length !== 1) {
          const [candidate] = mergedDeliveries.length === 1 ? mergedDeliveries : [];
          const coordinates = candidate
            ? { observedBaseSha: merge.targetBaseSha, priorHead: candidate.priorHead, ...(candidate.priorTree ? { priorTree: candidate.priorTree } : {}), ...(candidate.resultHead ? { resultHead: candidate.resultHead } : {}), ...(candidate.resultTree ? { resultTree: candidate.resultTree } : {}) }
            : { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree };
          return blocked("merge_state_ownership_mismatch", "human", true, "The Developer revision does not match the recorded forward merge", undefined, coordinates, candidate?.id ?? merge.forwardMergeId ?? checkId);
        }
        const provedDelivery = provenDeliveries[0];
        if (provedDelivery) {
          const { mergedDelivery, lineage } = provedDelivery;
          const coordinates = { observedBaseSha: merge.targetBaseSha, priorHead: mergedDelivery.priorHead, ...(mergedDelivery.priorTree ? { priorTree: mergedDelivery.priorTree } : {}), ...(mergedDelivery.resultHead ? { resultHead: mergedDelivery.resultHead } : {}), ...(mergedDelivery.resultTree ? { resultTree: mergedDelivery.resultTree } : {}) };
          const mergedArtifacts = (mergedDelivery.verificationArtifactId || mergedDelivery.deliveryArtifactId)
            ? database.authQuery((db) => db.prepare("SELECT id, kind FROM forge_artifacts WHERE company_id = ? AND (id = ? OR id = ?) ORDER BY id").all(input.companyId, mergedDelivery.verificationArtifactId, mergedDelivery.deliveryArtifactId) as Array<{ id: string; kind: string }>)
            : [];
          const mergedVerificationArtifact = mergedArtifacts.find((artifact) => artifact.id === mergedDelivery.verificationArtifactId && artifact.kind === "forward-merge-verification");
          const mergedDeliveryArtifact = mergedArtifacts.find((artifact) => artifact.id === mergedDelivery.deliveryArtifactId && isDeliveryArtifactKind(artifact.kind));
          if (mergedDelivery.failureCode !== null || mergedDelivery.failureSummary !== null) {
            const failureCode = mergedDelivery.failureCode;
            const failureSummary = mergedDelivery.failureSummary;
            if (!isVerificationBlockerCode(failureCode) || !failureSummary) {
              return blocked("merge_state_ownership_mismatch", "human", true, "The recorded forward merge is not an exact verification failure", undefined, coordinates, mergedDelivery.id);
            }
            if (!mergedVerificationArtifact) {
              return blocked("artifact_unavailable", "human", false, "The stored forward-merge verification artifact is unavailable", undefined, coordinates, mergedDelivery.id);
            }
            return blocked(failureCode, "lead", true, failureSummary, artifactReference({ id: mergedVerificationArtifact.id, kind: "forward-merge-verification" }), coordinates, mergedDelivery.id);
          }
          if (lineage.developer.status !== "completed") {
            return blocked("merge_state_ownership_mismatch", "human", true, "The completed Developer revision does not match the recorded forward merge", undefined, coordinates, mergedDelivery.id);
          }
          if (!mergedVerificationArtifact || !mergedDeliveryArtifact || context.deliveryArtifactId !== mergedDelivery.deliveryArtifactId) {
            return blocked("artifact_unavailable", "human", false, "The stored forward-merge delivery artifacts are unavailable", undefined, coordinates, mergedDelivery.id);
          }
          const deliverySha = database.authQuery((db) => db.prepare("SELECT sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(mergedDeliveryArtifact.id, input.companyId) as { sha256: string } | undefined)?.sha256;
          if (!deliverySha) return blocked("artifact_unavailable", "human", false, "The stored forward-merge delivery artifact is unavailable", undefined, coordinates, mergedDelivery.id);
          reusedDeliveryArtifact = { id: mergedDeliveryArtifact.id, kind: mergedDeliveryArtifact.kind as DeliveryArtifactKind, sha256: deliverySha };
          const verificationSha = database.authQuery((db) => db.prepare("SELECT sha256 FROM forge_artifacts WHERE id = ? AND company_id = ?").get(mergedVerificationArtifact.id, input.companyId) as { sha256: string } | undefined)?.sha256;
          reusedVerificationArtifact = { id: mergedVerificationArtifact.id, kind: "forward-merge-verification", ...(verificationSha ? { sha256: verificationSha } : {}) };
          if (lineage.kind !== "transitive" && !adoptStoredDelivery({ developerExecutionId: lineage.developer.id, priorHead: lineage.current.priorHead, priorTree: lineage.current.priorTree, resultHead: lineage.current.resultHead, resultTree: lineage.current.resultTree })) {
            return blocked("merge_state_ownership_mismatch", "human", true, "The completed Developer revision does not match the recorded forward merge", undefined, coordinates, mergedDelivery.id);
          }
        }
        if (!provedDelivery) {
          try {
            const adopted = await adoptObservedTaskBranch();
            if (adopted) return adopted;
          } catch (error) {
            const failure = reconcileBlocker(error);
            return blocked(failure.code, failure.owner, failure.retryable, failure.summary);
          }
        }
        return { outcome: "no_drift", checkId: merge.forwardMergeId ?? checkId, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: merge.targetBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree, ...(provedDelivery && reusedDeliveryArtifact && reusedVerificationArtifact ? { developerExecutionId: provedDelivery.mergedDelivery.developerExecutionId!, deliveryArtifact: artifactReference(reusedDeliveryArtifact), verificationArtifact: artifactReference(reusedVerificationArtifact) } : {}) };
      }
      const guard = await createGitCommandGuard(config.runtimeRoot);
      try {
        const verification = await runPinnedVerification({ taskId: input.taskId, stepId: merge.forwardMergeId ?? checkId, worktreePath: context.worktreePath, setupCommand: pinned.setupCommand, verificationCommand: pinned.verificationCommand, runtimeRoot: config.runtimeRoot }, { guard });
        let base: BaseVerificationOutcome | undefined;
        if (verification.outcome !== "passed") {
          try {
            await service.assertMergedOwnership({ worktreePath: context.worktreePath, branchName: context.branchName, priorHead: merge.priorHead, targetBaseSha: merge.targetBaseSha, mergeCommit: merge.mergeCommit!, tree: merge.tree! });
          } catch {
            const verificationArtifact = await artifacts.putArtifact(input.companyId, "forward-merge-verification", { filename: `${merge.forwardMergeId ?? checkId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(verification), "utf8") });
            const summary = "Pinned verification changed the forward-merge delivery";
            database.authTransaction((db) => db.prepare("UPDATE forge_forward_merges SET result_head = ?, result_tree = ?, verification_artifact_id = ?, verification_artifact_sha256 = ?, failure_code = ?, failure_summary = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ?").run(merge.mergeCommit, merge.tree, verificationArtifact.id, verificationArtifact.sha256, "merge_state_ownership_mismatch", summary, new Date().toISOString(), merge.forwardMergeId ?? "", input.taskId, input.companyId));
            return blocked("merge_state_ownership_mismatch", "human", true, summary, artifactReference(verificationArtifact), { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, resultHead: merge.mergeCommit!, resultTree: merge.tree! }, merge.forwardMergeId ?? checkId);
          }
          base = await verifyBase(merge.targetBaseSha, guard);
        }
        const verificationPayload: ForwardMergeVerificationPayload = base?.outcome === "failed"
          ? { ...verification, summary: "The base branch does not pass verification. GitHub CI judges the pull request.", base }
          : { ...verification, ...(base ? { base } : {}) };
        const verificationArtifact = await artifacts.putArtifact(input.companyId, "forward-merge-verification", { taskId: input.taskId, filename: `${merge.forwardMergeId ?? checkId}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(verificationPayload), "utf8") });
        const recordVerification = (code: string | null, summary: string | null): void => {
          database.authTransaction((db) => db.prepare("UPDATE forge_forward_merges SET result_head = ?, result_tree = ?, verification_artifact_id = ?, verification_artifact_sha256 = ?, failure_code = ?, failure_summary = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ?").run(merge.mergeCommit, merge.tree, verificationArtifact.id, verificationArtifact.sha256, code, summary, new Date().toISOString(), merge.forwardMergeId ?? "", input.taskId, input.companyId));
        };
        if (verification.outcome !== "passed") {
          if (base?.outcome === "failed") {
            recordVerification(null, null);
          } else {
          recordVerification(verification.code ?? "verification_failed", verification.summary);
          return blocked(verification.code === "verification_timed_out" ? "verification_timed_out" : verification.code === "verification_evidence_too_large" ? "verification_evidence_too_large" : "verification_failed", "lead", true, verification.summary, artifactReference(verificationArtifact), { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, resultHead: merge.mergeCommit!, resultTree: merge.tree! }, merge.forwardMergeId ?? checkId);
          }
        }
        await service.assertMergedOwnership({ worktreePath: context.worktreePath, branchName: context.branchName, priorHead: merge.priorHead, targetBaseSha: merge.targetBaseSha, mergeCommit: merge.mergeCommit!, tree: merge.tree! });
        const inheritedDeliveryArtifact = !context.deliveryArtifactId ? database.authQuery((db) => db.prepare(`WITH RECURSIVE execution_lineage(id, supersedes_execution_id, delivery_artifact_id, depth, path) AS (
            SELECT id, supersedes_execution_id, delivery_artifact_id, 0, '|' || id || '|'
            FROM forge_developer_executions
            WHERE id = ? AND task_id = ? AND company_id = ? AND workflow_id = ? AND plan_revision = ?
            UNION ALL
            SELECT prior.id, prior.supersedes_execution_id, prior.delivery_artifact_id, lineage.depth + 1, lineage.path || prior.id || '|'
            FROM execution_lineage lineage
            JOIN forge_developer_executions prior ON prior.id = lineage.supersedes_execution_id
              AND prior.task_id = ? AND prior.company_id = ? AND prior.workflow_id = ? AND prior.plan_revision = ?
            WHERE lineage.depth < 100 AND instr(lineage.path, '|' || prior.id || '|') = 0
          )
          SELECT artifact.id, artifact.sha256, artifact.kind
          FROM execution_lineage lineage
          JOIN forge_artifacts artifact ON artifact.id = lineage.delivery_artifact_id
            AND artifact.company_id = ? AND artifact.kind IN ('developer-delivery', 'forward-merge-delivery')
          WHERE lineage.depth > 0 AND length(artifact.sha256) = 64 AND lower(artifact.sha256) NOT GLOB '*[^0-9a-f]*'
          ORDER BY lineage.depth ASC
          LIMIT 1`).get(context.developerExecutionId, input.taskId, input.companyId, input.workflowId, context.planRevision, input.taskId, input.companyId, input.workflowId, context.planRevision, input.companyId) as { id: string; sha256: string; kind: string } | undefined) : undefined;
        const deliveryArtifact = context.deliveryArtifactId && context.deliveryArtifactSha256 && /^[a-f0-9]{64}$/i.test(context.deliveryArtifactSha256)
          ? (isDeliveryArtifactKind(context.deliveryArtifactKind) ? { id: context.deliveryArtifactId, sha256: context.deliveryArtifactSha256, kind: context.deliveryArtifactKind } : undefined)
          : inheritedDeliveryArtifact && isDeliveryArtifactKind(inheritedDeliveryArtifact.kind) ? inheritedDeliveryArtifact : undefined;
        if (!deliveryArtifact || !context.evidenceArtifactId) return blocked("artifact_unavailable", "human", false, "The prior Developer delivery artifact is unavailable", artifactReference(verificationArtifact), { observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, resultHead: merge.mergeCommit!, resultTree: merge.tree! }, merge.forwardMergeId ?? checkId);
        const newExecutionId = `developer_${randomBytes(12).toString("hex")}`;
        const now = new Date().toISOString();
        const nextAttempt = Number((database.authQuery((db) => db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM forge_developer_executions WHERE workflow_id = ? AND plan_revision = ?").get(input.workflowId, context.planRevision) as { attempt: number })).attempt) + 1;
        database.authTransaction((db) => {
          db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, supersedes_execution_id, session_ref, started_at, finished_at, heartbeat_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id, execution_kind) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'clean', ?, ?, 'forward_merge')").run(newExecutionId, input.taskId, input.companyId, input.workflowId, context.planRevision, nextAttempt, context.branchName, context.worktreePath, merge.targetBaseSha, context.developerExecutionId, context.developerSessionRef, now, now, now, merge.mergeCommit, merge.tree, deliveryArtifact.id, context.evidenceArtifactId);
          db.prepare("UPDATE forge_forward_merges SET result_head = ?, result_tree = ?, developer_execution_id = ?, verification_artifact_id = ?, verification_artifact_sha256 = ?, delivery_artifact_id = ?, delivery_artifact_sha256 = ?, supersedes_delivery_artifact_id = ?, supersedes_evidence_artifact_id = ?, updated_at = ? WHERE id = ? AND task_id = ? AND company_id = ?").run(merge.mergeCommit, merge.tree, newExecutionId, verificationArtifact.id, verificationArtifact.sha256, deliveryArtifact.id, deliveryArtifact.sha256, deliveryArtifact.id, context.evidenceArtifactId, now, merge.forwardMergeId ?? "", input.taskId, input.companyId);
        });
        return { outcome: "revalidated", checkId: merge.forwardMergeId ?? checkId, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: merge.targetBaseSha, priorHead: merge.priorHead, priorTree: merge.priorTree, headSha: merge.mergeCommit!, headTree: merge.tree!, developerExecutionId: newExecutionId, deliveryArtifact: artifactReference(deliveryArtifact), verificationArtifact: artifactReference(verificationArtifact), developerEvidenceArtifactId: context.evidenceArtifactId };
      } catch (error) {
        if (error instanceof ForwardMergeFailure) {
          const failure = reconcileBlocker(error);
          return blocked(failure.code, failure.owner, failure.retryable, failure.summary);
        }
        return blocked("verification_failed", "lead", true, "Pinned verification could not be completed");
      } finally { await guard.cleanup(); }
    },
  };
}
