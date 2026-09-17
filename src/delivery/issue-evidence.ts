import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { ArtifactStore } from "../platform/artifacts.js";
import type { TaskControlStore } from "../coordination/root-session-store.js";
import { taskEvidenceRoot } from "../coordination/workflow-evidence.js";
import { IssueAssociationSchema } from "../tasks/issue-association.js";
import { TrackerConnectionSchema } from "../projects/integration-configuration.js";
import { IssueTracker } from "../integrations/issue-tracker.js";
import { BitbucketClient } from "../integrations/bitbucket.js";
import { taskTracker } from "../tasks/issue-context.js";
import type { DeliveryGithubPort } from "./publication.js";
import { DeliveryOperationFailure } from "./failure.js";

const limit = 8 * 1024 * 1024;
const command = z.object({ command: z.string().min(1), output: z.string() }).strict();
const filename = z.string().min(1).refine(value => basename(value) === value && value !== "." && value !== ".." && !value.includes("\\"));
export const DeliveryEvidenceSchema = z.object({
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/i), summary: z.string().min(1),
  before: z.array(command).min(1), after: z.array(command).min(1), howToVerify: z.array(z.string().min(1)).min(1),
  screenshots: z.array(z.object({ filename, phase: z.enum(["before", "after"]) }).strict()).max(20).default([]),
}).strict();
const publicationSchema = z.object({
  issue: IssueAssociationSchema, tracker: TrackerConnectionSchema, headSha: z.string(),
  body: z.string().optional(), evidenceBody: z.string().optional(), commentId: z.string().optional(),
});
const storedSchema = z.object({ id: z.string(), companyId: z.string(), filename: z.string(), mimeType: z.string(), storagePath: z.string(), sha256: z.string() });
const mutations = new Map<string, Promise<void>>();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function renderDeliveryEvidence(value: z.infer<typeof DeliveryEvidenceSchema>, links: string[]): string {
  const commands = (items: z.infer<typeof command>[]) => items.map(item => {
    const fence = "`".repeat(Math.max(3, ...(item.output.match(/`+/g) ?? []).map(run => run.length + 1)));
    return `${item.command}\n\n${fence}text\n${item.output}\n${fence}`;
  }).join("\n\n");
  return `## What changed\n\n${value.summary}\n\nSource: ${value.headSha}\n\n## Before\n\n${commands(value.before)}\n\n## After\n\n${commands(value.after)}\n\n## How to verify\n\n${value.howToVerify.map(step => `- ${step}`).join("\n")}\n\n${links.join("\n")}`.trim();
}

/** The manifest and screenshot bytes remain available after the worktree is removed. */
export class IssueEvidence {
  private readonly artifacts: ArtifactStore;
  constructor(private readonly store: TaskControlStore, artifactRoot = join(dirname(store.database.filename()), "artifacts")) {
    this.artifacts = new ArtifactStore(artifactRoot, store.database);
  }

  private async readGenerated(taskId: string, name: string): Promise<Buffer> {
    filename.parse(name);
    const directory = join(taskEvidenceRoot(this.store.database.filename()), taskId, "generated");
    // Reject symlinked directories as well as symlinked files before reading Worker-owned evidence.
    if (await realpath(directory) !== join(await realpath(taskEvidenceRoot(this.store.database.filename())), taskId, "generated")) throw new Error("Evidence directory must not be a symbolic link");
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > limit) throw new Error("Evidence must be a regular file of at most 8 MiB");
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw new Error("Evidence changed while Forge read it");
      return bytes.subarray(0, bytesRead);
    } finally { await file.close(); }
  }

  private retained(taskId: string, name: string) {
    return this.store.database.authQuery(db => z.array(storedSchema).parse(db.prepare("SELECT id, company_id AS companyId, filename, mime_type AS mimeType, storage_path AS storagePath, sha256 FROM forge_artifacts WHERE task_id = ? AND filename = ? AND kind LIKE 'delivery-%' ORDER BY created_at DESC").all(taskId, name)));
  }

  private async retain(taskId: string, name: string, mimeType: string, bytes: Buffer) {
    const companyId = this.store.database.authQuery(db => z.object({ company_id: z.string() }).parse(db.prepare("SELECT company_id FROM forge_tasks WHERE id = ?").get(taskId)).company_id);
    const existing = this.retained(taskId, name).find(item => item.sha256 === hash(bytes));
    if (existing) return existing;
    return this.artifacts.putArtifact(companyId, mimeType.startsWith("image/") ? "delivery-image" : "delivery-evidence", { filename: name, mimeType, bytes, taskId });
  }

  private async manifest(taskId: string, headSha: string) {
    const name = `${headSha}-delivery-evidence.json`;
    let bytes: Buffer;
    try { bytes = await this.readGenerated(taskId, "delivery-evidence.json"); }
    catch (error) {
      for (const item of this.retained(taskId, name)) {
        const saved = await this.artifacts.getArtifact(item);
        if (hash(saved) !== item.sha256) throw new Error("Stored delivery evidence is corrupt");
        const parsed = DeliveryEvidenceSchema.parse(JSON.parse(saved.toString("utf8")));
        if (parsed.headSha === headSha) return parsed;
      }
      throw error;
    }
    const value = DeliveryEvidenceSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (value.headSha !== headSha) throw new Error("Delivery evidence is not for the reviewed source");
    await this.retain(taskId, name, "application/json", bytes);
    return value;
  }

  async complete(taskId: string, number: number, headSha: string, port: DeliveryGithubPort, recheck: () => void = () => {}) {
    const key = `${this.store.database.filename()}:${taskId}`;
    const previous = mutations.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.publish(taskId, number, headSha, port, recheck));
    mutations.set(key, run);
    try { await run; } finally { if (mutations.get(key) === run) mutations.delete(key); }
  }

  private async publish(taskId: string, number: number, headSha: string, port: DeliveryGithubPort, recheck: () => void) {
    const row = this.store.database.authQuery(db => z.object({ issue_json: z.string().nullable(), issue_publication_json: z.string().nullable() }).parse(db.prepare("SELECT issue_json, issue_publication_json FROM forge_tasks WHERE id = ?").get(taskId)));
    if (!row.issue_json && !row.issue_publication_json) return;
    const configuration = this.store.context(taskId).configuration;
    // Issue-backed draft delivery is opt-in; existing ready/merge workflows keep their completion semantics.
    if (this.store.get(taskId).deliveryTarget !== "pull_request_draft") return;
    let publication = row.issue_publication_json ? publicationSchema.parse(JSON.parse(row.issue_publication_json)) : publicationSchema.parse({ issue: JSON.parse(row.issue_json!), tracker: taskTracker(configuration), headSha });
    if (publication.headSha !== headSha) publication = { issue: publication.issue, tracker: publication.tracker, headSha, ...(publication.commentId ? { commentId: publication.commentId } : {}) };
    const save = () => this.store.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET issue_publication_json = ? WHERE id = ?").run(JSON.stringify(publication), taskId));
    recheck();
    const current = this.store.get(taskId);
    if (current.status !== "active") throw new DeliveryOperationFailure("workflow_review_required", "Resume the task before publishing issue evidence.");
    if (current.workflowState.acceptedDelivery?.headSha !== headSha) throw new DeliveryOperationFailure("delivery_review_required", "Review the current source before publishing issue evidence.");
    const inspectBeforeWrite = async () => {
      const control = this.store.get(taskId);
      if (!control.worktree) throw new Error("The task worktree is unavailable");
      const local = await port.inspectLocalRevision({ cwd: control.worktree.path });
      const remote = await port.getPullRequest({ repository: configuration.repository, number });
      if (remote.headSha !== headSha || remote.repository !== configuration.repository || remote.number !== number) throw new Error("The pull request changed before evidence publication");
      const latest = this.store.get(taskId);
      if (latest.status !== "active" || latest.workflowState.acceptedDelivery?.headSha !== headSha) throw new Error("Task authorization changed before evidence publication");
      if (local.headSha !== headSha || local.branch !== latest.deliveryIntent.headBranch || !local.clean) throw new Error("Review the clean task branch before publishing evidence");
      recheck();
      return remote;
    };
    const beforeWrite = async () => { await inspectBeforeWrite(); };
    save();
    try {
      let rendered = publication.evidenceBody;
      const tracker = new IssueTracker(publication.tracker);
      if (rendered === undefined) {
      const evidence = await this.manifest(taskId, headSha);
      const links: string[] = [];
      for (const screenshot of evidence.screenshots) {
        const extension = screenshot.filename.split(".").pop()?.toLowerCase();
        const mime = extension === "png" ? "image/png" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "webp" ? "image/webp" : null;
        if (!mime) throw new Error("Evidence screenshots must be PNG, JPEG or WebP");
        let bytes: Buffer;
        try { bytes = await this.readGenerated(taskId, screenshot.filename); }
        catch (error) {
          const item = this.retained(taskId, `${headSha}-${screenshot.filename}`)[0];
          if (!item) throw error;
          bytes = await this.artifacts.getArtifact(item);
          if (hash(bytes) !== item.sha256) throw new Error("Stored screenshot is corrupt");
        }
        await this.retain(taskId, `${headSha}-${screenshot.filename}`, mime, bytes);
        const name = `forge-${taskId}-${hash(bytes)}.${extension}`;
        recheck();
        const repositoryConnection = configuration.integration?.repository;
        const url = repositoryConnection?.kind === "bitbucket"
          ? await new BitbucketClient(repositoryConnection).upload(configuration.repository, name, bytes, mime, beforeWrite)
          : await tracker.upload(publication.issue, name, bytes, mime, beforeWrite);
        links.push(`[${screenshot.phase}: ${screenshot.filename}](${url})`);
        if (repositoryConnection?.kind === "bitbucket" && publication.issue.kind === "jira") {
          recheck();
          const issueUrl = await tracker.upload(publication.issue, name, bytes, mime, beforeWrite);
          links.push(`[${screenshot.phase}: ${screenshot.filename} (Jira)](${issueUrl})`);
        }
      }
      rendered = renderDeliveryEvidence(evidence, links);
      }
      const repository = configuration.repository;
      const pull = await inspectBeforeWrite();
      if (pull.headSha !== headSha) throw new Error("The pull request source changed before evidence publication");
      const marker = `<!-- forge-evidence:${taskId} -->`;
      const endMarker = `<!-- /forge-evidence:${taskId} -->`;
      if (pull.body === undefined || pull.title === undefined) throw new Error("The repository did not return the pull request title and body");
      const start = pull.body.indexOf(marker);
      const end = start < 0 ? -1 : pull.body.indexOf(endMarker, start + marker.length);
      const block = `${marker}\n${rendered}\n${endMarker}`;
      const body = start >= 0 && end >= 0
        ? `${pull.body.slice(0, start)}${block}${pull.body.slice(end + endMarker.length)}`
        : `${pull.body.trim()}\n\n${block}`;
      if (pull.body !== body) {
        if (!port.updateDraftPullRequest) throw new Error("The repository provider cannot update delivery evidence");
        await port.updateDraftPullRequest({ repository, number, title: pull.title, body });
      }
      const observed = await port.getPullRequest({ repository, number });
      if (observed.headSha !== headSha || observed.body !== body) throw new Error("The repository has not confirmed the evidence and reviewed source");
      publication = { ...publication, evidenceBody: rendered, body: `${rendered}\n\nPull request: ${observed.url}` };
      save();
      recheck();
      const commentId = await tracker.publish(publication.issue, taskId, publication.body!, beforeWrite, publication.commentId);
      publication = { ...publication, commentId };
      save();
      await beforeWrite();
    } catch (error) {
      throw new DeliveryOperationFailure("workflow_review_required", `Complete ${join(taskEvidenceRoot(this.store.database.filename()), taskId, "generated", "delivery-evidence.json")} for reviewed head ${headSha}, then retry publication. Include summary, before/after arrays of {command, output}, howToVerify steps, and optional screenshots [{filename, phase: "before"|"after"}]. Preserve real evidence; do not invent Before output. ${error instanceof Error ? error.message : "Evidence is unavailable"}`);
    }
  }
}
