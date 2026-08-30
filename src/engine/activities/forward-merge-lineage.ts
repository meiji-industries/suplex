import type Database from "better-sqlite3";

const maxForwardMergeLineageDepth = 32;

type ForwardMergeRow = {
  id: string;
  expectedBaseSha: string;
  currentBaseSha: string;
  priorHead: string;
  priorTree: string | null;
  mergeCommit: string | null;
  mergeTree: string | null;
  resultHead: string | null;
  resultTree: string | null;
  verificationArtifactId: string | null;
};

export type ForwardMergeLineageCoordinates = {
  id: string;
  expectedBaseSha: string;
  currentBaseSha: string;
  priorHead: string;
  priorTree: string;
  resultHead: string;
  resultTree: string;
  verificationArtifactId: string | null;
};

export type ForwardMergeLineageProof = {
  kind: "direct-prior" | "direct-result" | "transitive";
  developer: {
    id: string;
    status: string;
    targetBaseSha: string;
    resultHead: string;
    resultTree: string;
  };
  current: ForwardMergeLineageCoordinates;
  root: ForwardMergeLineageCoordinates;
  ancestors: ForwardMergeLineageCoordinates[];
};

export type ForwardMergeLineageInput = {
  currentMergeId: string;
  taskId: string;
  companyId: string;
  workflowId: string;
  projectRevisionId: string;
  checkpoint: string;
  developerExecutionId: string;
};

function sameRevision(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function revisionKey(head: string, tree: string): string {
  return `${head.toLowerCase()}|${tree.toLowerCase()}`;
}

function coordinates(row: ForwardMergeRow): ForwardMergeLineageCoordinates | undefined {
  if (!row.priorTree || !row.mergeCommit || !row.mergeTree || !row.resultHead || !row.resultTree
    || !sameRevision(row.mergeCommit, row.resultHead) || !sameRevision(row.mergeTree, row.resultTree)) return undefined;
  return {
    id: row.id,
    expectedBaseSha: row.expectedBaseSha,
    currentBaseSha: row.currentBaseSha,
    priorHead: row.priorHead,
    priorTree: row.priorTree,
    resultHead: row.resultHead,
    resultTree: row.resultTree,
    verificationArtifactId: row.verificationArtifactId,
  };
}

export function proveForwardMergeLineage(db: Database.Database, input: ForwardMergeLineageInput): ForwardMergeLineageProof | undefined {
  const currentRecord = db.prepare(`SELECT
      m.id, m.expected_base_sha AS expectedBaseSha, m.current_base_sha AS currentBaseSha,
      m.prior_head AS priorHead, m.prior_tree AS priorTree, m.merge_commit AS mergeCommit,
      m.tree AS mergeTree, m.result_head AS resultHead, m.result_tree AS resultTree,
      m.verification_artifact_id AS verificationArtifactId,
      d.id AS developerExecutionId, d.status AS developerStatus,
      d.target_base_sha AS developerTargetBaseSha, d.result_commit AS developerResultHead,
      d.result_tree AS developerResultTree
    FROM forge_forward_merges m
    JOIN forge_developer_executions d
      ON d.id = m.developer_execution_id AND d.task_id = m.task_id
      AND d.company_id = m.company_id AND d.workflow_id = m.workflow_id
    WHERE m.id = ? AND m.task_id = ? AND m.company_id = ? AND m.workflow_id = ?
      AND m.project_revision_id = ? AND m.checkpoint = ? AND m.status = 'merged'
      AND m.developer_execution_id = ?`).get(
    input.currentMergeId,
    input.taskId,
    input.companyId,
    input.workflowId,
    input.projectRevisionId,
    input.checkpoint,
    input.developerExecutionId,
  ) as (ForwardMergeRow & {
    developerExecutionId: string;
    developerStatus: string;
    developerTargetBaseSha: string;
    developerResultHead: string | null;
    developerResultTree: string | null;
  }) | undefined;
  if (!currentRecord || !["completed", "blocked"].includes(currentRecord.developerStatus)
    || !currentRecord.developerResultHead || !currentRecord.developerResultTree) return undefined;
  const current = coordinates(currentRecord);
  if (!current) return undefined;
  const developer = {
    id: currentRecord.developerExecutionId,
    status: currentRecord.developerStatus,
    targetBaseSha: currentRecord.developerTargetBaseSha,
    resultHead: currentRecord.developerResultHead,
    resultTree: currentRecord.developerResultTree,
  };
  const executionAtPrior = sameRevision(developer.resultHead, current.priorHead) && sameRevision(developer.resultTree, current.priorTree);
  if (executionAtPrior && sameRevision(developer.targetBaseSha, current.expectedBaseSha)) {
    return { kind: "direct-prior", developer, current, root: current, ancestors: [] };
  }
  const executionAtResult = sameRevision(developer.resultHead, current.resultHead) && sameRevision(developer.resultTree, current.resultTree);
  if (executionAtResult && (sameRevision(developer.targetBaseSha, current.expectedBaseSha) || sameRevision(developer.targetBaseSha, current.currentBaseSha))) {
    return { kind: "direct-result", developer, current, root: current, ancestors: [] };
  }
  if (executionAtPrior || executionAtResult) return undefined;

  const visited = new Set([current.id]);
  const visitedRevisions = new Set([revisionKey(current.resultHead, current.resultTree), revisionKey(current.priorHead, current.priorTree)]);
  const ancestors: ForwardMergeLineageCoordinates[] = [];
  let cursorHead = current.priorHead;
  let cursorTree = current.priorTree;
  let newerExpectedBase = current.expectedBaseSha;
  for (let depth = 1; depth <= maxForwardMergeLineageDepth; depth += 1) {
    const rows = db.prepare(`SELECT
        m.id, m.expected_base_sha AS expectedBaseSha, m.current_base_sha AS currentBaseSha,
        m.prior_head AS priorHead, m.prior_tree AS priorTree, m.merge_commit AS mergeCommit,
        m.tree AS mergeTree, m.result_head AS resultHead, m.result_tree AS resultTree,
        m.verification_artifact_id AS verificationArtifactId
      FROM forge_forward_merges m
      JOIN forge_artifacts verification
        ON verification.id = m.verification_artifact_id AND verification.company_id = m.company_id
        AND verification.kind = 'forward-merge-verification'
      WHERE m.task_id = ? AND m.company_id = ? AND m.workflow_id = ?
        AND m.project_revision_id = ? AND m.checkpoint = ? AND m.status = 'merged'
        AND m.developer_execution_id = ?
        AND m.prior_tree IS NOT NULL AND m.merge_commit IS NOT NULL AND m.tree IS NOT NULL
        AND m.result_head IS NOT NULL AND m.result_tree IS NOT NULL
        AND lower(m.merge_commit) = lower(m.result_head) AND lower(m.tree) = lower(m.result_tree)
        AND lower(m.result_head) = lower(?) AND lower(m.result_tree) = lower(?)`).all(
      input.taskId,
      input.companyId,
      input.workflowId,
      input.projectRevisionId,
      input.checkpoint,
      input.developerExecutionId,
      cursorHead,
      cursorTree,
    ) as ForwardMergeRow[];
    const predecessors = rows.flatMap((row) => {
      const predecessor = coordinates(row);
      return predecessor && sameRevision(predecessor.currentBaseSha, newerExpectedBase) ? [predecessor] : [];
    });
    if (predecessors.length !== 1) return undefined;
    const predecessor = predecessors[0]!;
    if (visited.has(predecessor.id)) return undefined;
    visited.add(predecessor.id);
    ancestors.push(predecessor);
    const predecessorPriorKey = revisionKey(predecessor.priorHead, predecessor.priorTree);
    if (visitedRevisions.has(predecessorPriorKey)) return undefined;
    visitedRevisions.add(predecessorPriorKey);
    if (sameRevision(developer.resultHead, predecessor.priorHead) && sameRevision(developer.resultTree, predecessor.priorTree)) {
      if (!sameRevision(developer.targetBaseSha, predecessor.expectedBaseSha)) return undefined;
      return { kind: "transitive", developer, current, root: predecessor, ancestors };
    }
    cursorHead = predecessor.priorHead;
    cursorTree = predecessor.priorTree;
    newerExpectedBase = predecessor.expectedBaseSha;
  }
  return undefined;
}
