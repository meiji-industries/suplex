import { randomUUID } from "node:crypto";

import type { ForgeDatabase } from "./database.js";
import { json } from "./task-utils.js";

export interface DeveloperResultClaim {
  executionId: string;
  claimKey: string;
  resultHash?: string | null;
  activityResult: unknown;
  deliveryArtifactId: string;
  evidenceArtifactId: string;
}

export class DeveloperResultConflict extends Error {
  constructor(readonly executionId: string) {
    super("A different Developer result was already claimed for this execution");
    this.name = "DeveloperResultConflict";
  }
}

/**
 * The Developer execution ledger is the result ownership boundary.  A retry
 * either gets its original activity value or leaves durable evidence of a
 * conflicting completion; it can never overwrite the first result.
 */
export function claimDeveloperResult(database: ForgeDatabase, claim: DeveloperResultClaim): unknown {
  const outcome = database.authQuery((db) => db.transaction(() => {
    const existing = db.prepare("SELECT result_hash, activity_result_json, delivery_artifact_id, evidence_artifact_id FROM forge_developer_result_claims WHERE execution_id = ?").get(claim.executionId) as { result_hash: string | null; activity_result_json: string; delivery_artifact_id: string; evidence_artifact_id: string } | undefined;
    if (!existing) {
      db.prepare("INSERT INTO forge_developer_result_claims (execution_id, claim_key, result_hash, activity_result_json, delivery_artifact_id, evidence_artifact_id, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(claim.executionId, claim.claimKey, claim.resultHash, JSON.stringify(claim.activityResult), claim.deliveryArtifactId, claim.evidenceArtifactId, new Date().toISOString());
      return { conflict: false as const, result: claim.activityResult };
    }
    if (!existing.result_hash || !claim.resultHash || existing.result_hash === claim.resultHash) return { conflict: false as const, result: json(existing.activity_result_json, claim.activityResult) };
    db.prepare("INSERT OR IGNORE INTO forge_developer_result_conflicts (id, execution_id, existing_result_hash, conflicting_result_hash, existing_delivery_artifact_id, existing_evidence_artifact_id, conflicting_delivery_artifact_id, conflicting_evidence_artifact_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`developer_result_conflict_${randomUUID().replaceAll("-", "")}`, claim.executionId, existing.result_hash, claim.resultHash, existing.delivery_artifact_id, existing.evidence_artifact_id, claim.deliveryArtifactId, claim.evidenceArtifactId, new Date().toISOString());
    return { conflict: true as const, result: json(existing.activity_result_json, claim.activityResult) };
  })());
  return outcome.result;
}
