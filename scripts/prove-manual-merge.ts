#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const stage = process.env.FORGE_MANUAL_MERGE_STAGE;
const baseUrl = process.env.FORGE_MANUAL_MERGE_BASE_URL;
const taskId = process.env.FORGE_MANUAL_MERGE_TASK_ID;
const cookie = process.env.FORGE_MANUAL_MERGE_COOKIE;
const csrfToken = process.env.FORGE_MANUAL_MERGE_CSRF_TOKEN;
const repository = process.env.FORGE_MANUAL_MERGE_REPOSITORY;
const baseBranch = process.env.FORGE_MANUAL_MERGE_BASE_BRANCH;
const expectedHeadSha = process.env.FORGE_MANUAL_MERGE_EXPECTED_HEAD_SHA;
const proofRoot = ".context/manual-merge-proof";

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function version(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 10_000, maxBuffer: 32 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function request(path: string, method = "GET", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
  const response = await fetch(`${required("FORGE_MANUAL_MERGE_BASE_URL", baseUrl)}${path}`, {
    method,
    headers: {
      accept: "application/json",
      cookie: required("FORGE_MANUAL_MERGE_COOKIE", cookie),
      ...(mutating ? { "x-csrf-v1": required("FORGE_MANUAL_MERGE_CSRF_TOKEN", csrfToken) } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Forge proof request failed (${response.status})`);
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Forge proof response was not an object");
  return value as Record<string, unknown>;
}

async function artifactJson(task: string, artifactId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${required("FORGE_MANUAL_MERGE_BASE_URL", baseUrl)}/api/tasks/${encodeURIComponent(task)}/artifacts/${encodeURIComponent(artifactId)}`, { headers: { accept: "application/json", cookie: required("FORGE_MANUAL_MERGE_COOKIE", cookie) } });
  if (!response.ok) throw new Error(`Forge receipt request failed (${response.status})`);
  const value: unknown = JSON.parse(await response.text());
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Forge completion receipt is not JSON");
  return value as Record<string, unknown>;
}

function gate(task: Record<string, unknown>): Record<string, unknown> {
  const value = task.deliveryGate;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("The exact delivery gate is not available");
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  if (stage !== "prepare" && stage !== "verify") throw new Error("FORGE_MANUAL_MERGE_STAGE must be prepare or verify");
  const task = required("FORGE_MANUAL_MERGE_TASK_ID", taskId);
  const repo = required("FORGE_MANUAL_MERGE_REPOSITORY", repository);
  const branch = required("FORGE_MANUAL_MERGE_BASE_BRANCH", baseBranch);
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repo)) throw new Error("FORGE_MANUAL_MERGE_REPOSITORY must be owner/repository");
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error("FORGE_MANUAL_MERGE_BASE_BRANCH is invalid");
  if (!(await version("node", ["--version"])) || !(await version("pnpm", ["--version"])) || !(await version("gh", ["--version"])) || !(await version("gh", ["auth", "status", "--hostname", "github.com"]))) throw new Error("Pinned Node/pnpm, gh, or authenticated gh is unavailable");
  const current = await request(`/api/tasks/${encodeURIComponent(task)}`);
  const revision = current.revision;
  if (typeof revision !== "number") throw new Error("Task revision is unavailable");
  const currentGate = gate(current);
  const currentRelease = currentGate.release as Record<string, unknown>;
  if (currentRelease.repository !== repo || currentRelease.baseBranch !== branch) throw new Error("The task is not pinned to the requested repository/base branch");
  if (stage === "prepare") {
    const expectedHead = required("FORGE_MANUAL_MERGE_EXPECTED_HEAD_SHA", expectedHeadSha);
    if (currentRelease.headSha !== expectedHead) throw new Error("The task head does not match the requested exact head");
    let accepted = current;
    if (accepted.phase === "accepted") accepted = await request(`/api/tasks/${encodeURIComponent(task)}/accept-delivery`, "POST", { expectedRevision: revision });
    if (accepted.phase !== "ready_reconciliation" && accepted.phase !== "manual_merge") throw new Error("The task is not available for acceptance or ready reconciliation");
    const initialAcceptanceId = (gate(accepted).acceptance as Record<string, unknown> | null)?.id ?? null;
    if (!initialAcceptanceId) throw new Error("Forge did not persist the acceptance intent before ready reconciliation");
    if (accepted.phase === "ready_reconciliation") accepted = await request(`/api/tasks/${encodeURIComponent(task)}/reconcile-acceptance`, "POST", { expectedRevision: accepted.revision });
    if (accepted.phase === "ready_reconciliation") throw new Error("Ready-for-review is not confirmed yet; rerun the prepare stage after the recorded retry time");
    if (accepted.phase !== "manual_merge") throw new Error("Ready reconciliation did not reach the manual-merge phase");
    const acceptedGate = gate(accepted);
    const acceptedRelease = acceptedGate.release as Record<string, unknown>;
    const finalAcceptanceId = (acceptedGate.acceptance as Record<string, unknown> | null)?.id ?? null;
    if (finalAcceptanceId !== initialAcceptanceId || acceptedRelease.repository !== repo || acceptedRelease.baseBranch !== branch || acceptedRelease.headSha !== expectedHead || acceptedRelease.state !== "ready") throw new Error("Forge did not produce the exact ready-for-review acceptance");
    const acceptedFinalReview = acceptedGate.finalReview as Record<string, unknown> | null;
    const acceptedCi = acceptedGate.ci as Record<string, unknown> | null;
    const acceptedAcceptance = acceptedGate.acceptance as Record<string, unknown> | null;
    const acceptedDeliveryReview = accepted.deliveryReview as Record<string, unknown> | null;
    const proof = { stage, recordedAt: new Date().toISOString(), taskId: task, workflowId: accepted.workflowId, projectRevisionId: accepted.projectRevisionId, revision: accepted.revision, repository: repo, baseBranch: branch, expectedHeadSha: expectedHead, expectedHeadTree: acceptedRelease.headTree, pullRequestNumber: acceptedRelease.pullRequestNumber, pullRequestUrl: acceptedRelease.pullRequestUrl, releaseId: acceptedRelease.id, deliveryReviewId: acceptedDeliveryReview?.id ?? null, finalReviewId: acceptedFinalReview?.id ?? null, finalReviewSessionRef: acceptedFinalReview?.sessionRef ?? null, ciRunId: acceptedCi?.id ?? null, acceptanceId: acceptedAcceptance?.id ?? null, actorUserId: acceptedAcceptance?.actorUserId ?? null, instruction: "Merge this exact ready PR manually outside Forge, then rerun with FORGE_MANUAL_MERGE_STAGE=verify." };
    await mkdir(proofRoot, { recursive: true, mode: 0o700 });
    await writeFile(`${proofRoot}/stage-1.json`, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ stage, pullRequestUrl: proof.pullRequestUrl, expectedHeadSha: expectedHead, instruction: proof.instruction })}\n`);
    return;
  }
  let stored: Record<string, unknown>;
  try { stored = JSON.parse(await readFile(`${proofRoot}/stage-1.json`, "utf8")) as Record<string, unknown>; } catch { throw new Error("Stage 2 requires the stage-1 proof file"); }
  if (stored.taskId !== task) throw new Error("Stage-1 proof is for a different task");
  for (const name of ["workflowId", "projectRevisionId", "repository", "baseBranch", "releaseId", "expectedHeadSha", "expectedHeadTree", "finalReviewId", "finalReviewSessionRef", "ciRunId", "acceptanceId", "actorUserId"] as const) if (typeof stored[name] !== "string" || !stored[name]) throw new Error(`Stage-1 proof is missing ${name}`);
  if (current.phase !== "manual_merge" || current.workflowId !== stored.workflowId || current.projectRevisionId !== stored.projectRevisionId || current.revision !== stored.revision) throw new Error("The task no longer matches the stage-1 manual-merge state");
  const currentFinalReview = currentGate.finalReview as Record<string, unknown> | null;
  const currentCi = currentGate.ci as Record<string, unknown> | null;
  const currentAcceptance = currentGate.acceptance as Record<string, unknown> | null;
  for (const [name, actual] of Object.entries({ releaseId: currentRelease.id, repository: currentRelease.repository, baseBranch: currentRelease.baseBranch, expectedHeadSha: currentRelease.headSha, expectedHeadTree: currentRelease.headTree, pullRequestNumber: currentRelease.pullRequestNumber, finalReviewId: currentFinalReview?.id, finalReviewSessionRef: currentFinalReview?.sessionRef, ciRunId: currentCi?.id, acceptanceId: currentAcceptance?.id, actorUserId: currentAcceptance?.actorUserId })) if (actual !== stored[name]) throw new Error(`Stage-1 identity mismatch for ${name}`);
  const reconciled = await request(`/api/tasks/${encodeURIComponent(task)}/reconcile-merge`, "POST", { expectedRevision: revision });
  const reconciledGate = gate(reconciled);
  const reconciledRelease = reconciledGate.release as Record<string, unknown>;
  const finalReview = reconciledGate.finalReview as Record<string, unknown> | null;
  const ci = reconciledGate.ci as Record<string, unknown> | null;
  const acceptance = reconciledGate.acceptance as Record<string, unknown> | null;
  const merge = reconciledGate.merge as Record<string, unknown>;
  const same = (name: string, actual: unknown): void => { if (actual !== stored[name]) throw new Error(`Stage-1 identity mismatch for ${name}`); };
  same("workflowId", reconciled.workflowId); same("projectRevisionId", reconciled.projectRevisionId); same("releaseId", reconciledRelease.id); same("repository", reconciledRelease.repository); same("baseBranch", reconciledRelease.baseBranch); same("expectedHeadSha", reconciledRelease.headSha); same("expectedHeadTree", reconciledRelease.headTree); same("pullRequestNumber", reconciledRelease.pullRequestNumber); same("finalReviewId", finalReview?.id); same("finalReviewSessionRef", finalReview?.sessionRef); same("ciRunId", ci?.id); same("acceptanceId", acceptance?.id); same("actorUserId", acceptance?.actorUserId);
  if (reconciled.phase !== "done" || !merge.receiptId || !merge.receiptArtifactId || merge.outcome !== "merged" || !merge.observationId || !merge.observedAt || !merge.mergedAt) throw new Error("Manual merge reconciliation has not reached a receipt-backed done state");
  const receipt = await artifactJson(task, String(merge.receiptArtifactId));
  for (const [name, expected] of Object.entries({ taskId: task, workflowId: stored.workflowId, projectRevisionId: stored.projectRevisionId, releaseId: stored.releaseId, acceptanceId: stored.acceptanceId, observationId: merge.observationId, deliveryReviewId: stored.deliveryReviewId, finalReviewId: stored.finalReviewId, ciRunId: stored.ciRunId, repository: repo, prNumber: stored.pullRequestNumber, baseBranch: branch, baseSha: reconciledRelease.baseSha, headSha: stored.expectedHeadSha, headTree: stored.expectedHeadTree, actorUserId: stored.actorUserId })) if (receipt[name] !== expected) throw new Error(`Completion receipt identity mismatch for ${name}`);
  const proof = { stage, recordedAt: new Date().toISOString(), taskId: task, revision: reconciled.revision, repository: repo, baseBranch: branch, expectedHeadSha: stored.expectedHeadSha, pullRequestUrl: reconciledRelease.pullRequestUrl, mergeObservationId: merge.observationId, completionReceiptId: merge.receiptId, observedAt: merge.observedAt, mergedAt: merge.mergedAt, deployment: reconciledGate.deployment };
  await mkdir(proofRoot, { recursive: true, mode: 0o700 });
  await writeFile(`${proofRoot}/stage-2.json`, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(proof)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Manual-merge proof failed"}\n`);
  process.exitCode = 1;
});
