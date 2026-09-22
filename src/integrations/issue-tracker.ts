// eslint-disable-next-line no-restricted-imports -- provider JSON must be bounded without command-output tail truncation.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { environmentCredential, type TrackerConnection } from "../projects/integration-configuration.js";
import { IssueAssociationSchema, type IssueAssociation, type IssueContext } from "../tasks/issue-association.js";
import { ProviderHttpFailure, providerBytes, providerJson } from "./provider-http.js";
import { MAX_TASK_IMAGE_BYTES } from "../tasks/limits/attachment-limits.js";
import { decodeTaskImage } from "../tasks/images.js";

const exec = promisify(execFile);
export class IssueTrackerScopeFailure extends Error {}
const githubIssue = z.object({ id: z.number(), number: z.number(), title: z.string(), html_url: z.string(), body: z.string().nullable().default(null), pull_request: z.unknown().optional() });
const jiraIssue = z.object({ id: z.string(), key: z.string(), fields: z.record(z.string(), z.unknown()), names: z.record(z.string(), z.string()).optional() });
const comment = z.object({ id: z.union([z.string(), z.number()]), body: z.unknown(), author: z.object({ accountId: z.string() }).optional(), user: z.object({ id: z.number() }).optional() });
const attachment = z.object({ id: z.union([z.string(), z.number()]).transform(String), filename: z.string(), size: z.number(), mimeType: z.string().optional(), author: z.object({ accountId: z.string() }).optional() });
const jiraPage = z.object({ issues: z.array(jiraIssue), nextPageToken: z.string().optional(), isLast: z.boolean().optional() });

export function issueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(issueText).join("\n");
  if (typeof value !== "object") return String(value);
  const node = z.object({ type: z.string().optional(), text: z.string().optional(), content: z.array(z.unknown()).optional() }).safeParse(value);
  if (node.success && (node.data.text !== undefined || node.data.content)) return node.data.text ?? node.data.content?.map(issueText).join(node.data.type === "paragraph" || node.data.type === "heading" ? "" : "\n") ?? "";
  return JSON.stringify(value);
}

export function jiraEvidenceDocument(text: string) {
  return { type: "doc", version: 1, content: text.split("\n").map(line => ({
    type: "paragraph",
    content: line.split(/(https:\/\/[^\s<>()]+)/).filter(Boolean).map(part => {
      if (!part.startsWith("https://")) return { type: "text", text: part };
      try {
        const url = new URL(part);
        if (url.username || url.password) return { type: "text", text: part };
        return { type: "text", text: part, marks: [{ type: "link", attrs: { href: url.href } }] };
      } catch { return { type: "text", text: part }; }
    }),
  })) };
}

async function gh(path: string, body?: unknown, method = "POST"): Promise<unknown> {
  const directory = body === undefined ? undefined : await mkdtemp(join(tmpdir(), "suplex-issue-"));
  try {
    const args = ["api", path];
    if (directory) {
      const file = join(directory, "body.json");
      await writeFile(file, JSON.stringify(body), { mode: 0o600 });
      args.push("--method", method, "--input", file);
    }
    const result = await exec(process.env.SUPLEX_GH_COMMAND ?? "gh", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  } catch (error) {
    const failure = z.object({ stderr: z.string() }).safeParse(error);
    const status = failure.success ? /\(HTTP (401|403|404)\)/.exec(failure.data.stderr)?.[1] : undefined;
    if (status) throw new ProviderHttpFailure(Number(status));
    throw new Error("GitHub could not complete the issue request");
  }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

export class IssueTracker {
  constructor(private readonly connection: TrackerConnection, private readonly request: typeof fetch = fetch, private readonly github: typeof gh = gh, private readonly githubCommand: (args: string[]) => Promise<{ stdout: string; stderr: string }> = args => exec(process.env.SUPLEX_GH_COMMAND ?? "gh", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })) {}

  private jiraCredentials() {
    if (this.connection.kind !== "jira") throw new Error("The project does not use Jira");
    return { origin: new URL(this.connection.site).origin, authorization: `Basic ${Buffer.from(`${environmentCredential(this.connection.emailEnvironment)}:${environmentCredential(this.connection.tokenEnvironment)}`).toString("base64")}` };
  }

  private jira(path: string, body?: unknown): Promise<unknown> {
    const { origin, authorization } = this.jiraCredentials();
    return providerJson(new URL(path, origin), origin, authorization, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }, this.request);
  }

  private async actor(): Promise<string> {
    return this.connection.kind === "jira" ? z.object({ accountId: z.string() }).parse(await this.jira("/rest/api/3/myself")).accountId : String(z.object({ id: z.number() }).parse(await this.github("user")).id);
  }

  private owned(row: z.infer<typeof comment>, actor: string): boolean {
    return row.author?.accountId === actor || row.user?.id !== undefined && String(row.user.id) === actor;
  }

  private async attachments(issue: Extract<IssueAssociation, { kind: "jira" }>) {
    return z.object({ fields: z.object({ attachment: z.array(attachment).default([]) }) }).parse(await this.jira(`/rest/api/3/issue/${issue.id}?fields=attachment`)).fields.attachment;
  }

  async images(issue: IssueAssociation, limit: number): Promise<{ images: Array<{ filename: string; mimeType: string; bytes: Buffer }>; notes: string[] }> {
    this.check(issue);
    const images: Array<{ filename: string; mimeType: string; bytes: Buffer }> = [];
    const notes: string[] = [];
    if (issue.kind !== "jira") return { images, notes };
    const current = jiraIssue.parse(await this.jira(`/rest/api/3/issue/${issue.id}?fields=summary,attachment`));
    this.check(this.reference(current));
    const { origin, authorization } = this.jiraCredentials();
    const rows = z.array(attachment).parse(current.fields.attachment ?? []);
    for (const file of rows.slice(0, 10)) {
      const mime = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).safeParse(file.mimeType);
      if (!mime.success) continue;
      if (images.length >= Math.min(8, Math.max(0, limit)) || file.size > MAX_TASK_IMAGE_BYTES) {
        notes.push(`Image ${file.filename} was not loaded: task image count or 8 MiB limit reached.`);
        continue;
      }
      try {
        const bytes = await providerBytes(new URL(`/rest/api/3/attachment/content/${file.id}?redirect=false`, origin), origin, authorization, {}, this.request, MAX_TASK_IMAGE_BYTES);
        decodeTaskImage({ filename: file.filename, mimeType: mime.data, base64: bytes.toString("base64") });
        const filename = file.filename.replace(/[\\/]/g, "_");
        images.push({ filename: filename || `attachment-${file.id}`, mimeType: mime.data, bytes });
      } catch { notes.push(`Image ${file.filename} could not be loaded. Review it in Jira.`); }
    }
    if (rows.length > 10) notes.push(`${rows.length - 10} additional attachments were not inspected for images. Review them in Jira.`);
    return { images, notes };
  }

  private async beforeMutation(issue: IssueAssociation, beforeWrite: () => Promise<void>): Promise<void> {
    if (issue.kind === "jira") {
      const current = jiraIssue.parse(await this.jira(`/rest/api/3/issue/${issue.id}?fields=summary`));
      this.check(this.reference(current));
    }
    await beforeWrite();
  }

  async upload(issue: IssueAssociation, filename: string, bytes: Buffer, mimeType: string, beforeWrite: () => Promise<void> = async () => {}): Promise<string> {
    this.check(issue);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (!new RegExp(`^suplex-[A-Za-z0-9_-]+-${hash}\\.[a-z0-9]+$`).test(filename) || !bytes.length || bytes.length > MAX_TASK_IMAGE_BYTES) throw new Error("Invalid task evidence attachment");
    const actor = await this.actor();
    if (issue.kind === "jira") {
      const { origin, authorization } = this.jiraCredentials();
      let existing = (await this.attachments(issue)).find(row => row.filename === filename && row.author?.accountId === actor);
      if (!existing) {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
        await this.beforeMutation(issue, beforeWrite);
        await providerJson(new URL(`/rest/api/3/issue/${issue.id}/attachments`, origin), origin, authorization, { method: "POST", body: form, headers: { "X-Atlassian-Token": "no-check" } }, this.request);
        existing = (await this.attachments(issue)).find(row => row.filename === filename && row.author?.accountId === actor);
      }
      if (!existing) throw new Error("Jira has not confirmed the evidence attachment");
      const url = new URL(`/rest/api/3/attachment/content/${existing.id}?redirect=false`, origin);
      const uploaded = await providerBytes(url, origin, authorization, {}, this.request, MAX_TASK_IMAGE_BYTES);
      if (createHash("sha256").update(uploaded).digest("hex") !== hash) throw new Error("The Jira attachment does not match the task evidence");
      return new URL(`/secure/attachment/${existing.id}/${encodeURIComponent(filename)}`, origin).href;
    }
    const marker = `[Suplex attachment ${filename}]`;
    const find = async () => (await this.comments(issue)).find(row => this.owned(row, actor) && issueText(row.body).includes(marker));
    let existing = await find();
    if (!existing) {
      const capability = await this.githubCommand(["issue", "comment", "--help"]);
      if (!capability.stdout.includes("--attach")) throw new Error("Update GitHub CLI to a version supporting issue comment --attach");
      const directory = await mkdtemp(join(tmpdir(), "suplex-evidence-upload-"));
      try {
        const path = join(directory, filename);
        const body = join(directory, "body.md");
        await writeFile(path, bytes, { mode: 0o600 });
        await writeFile(body, marker, { mode: 0o600 });
        await this.beforeMutation(issue, beforeWrite);
        await this.githubCommand(["issue", "comment", String(issue.number), "--repo", issue.repository, "--body-file", body, "--attach", path]);
      } finally { await rm(directory, { recursive: true, force: true }); }
      existing = await find();
    }
    const reference = existing ? issueText(existing.body).match(/!\[[^\]]*\]\((https:\/\/[^\s)]+)\)/)?.[1] : undefined;
    if (!reference) throw new Error("GitHub has not confirmed the uploaded evidence reference");
    const url = new URL(reference);
    if (!["github.com", "user-images.githubusercontent.com", "private-user-images.githubusercontent.com"].includes(url.hostname) || url.username || url.password) throw new Error("GitHub returned an unsafe evidence reference");
    return url.href;
  }

  private reference(row: z.infer<typeof jiraIssue>): IssueAssociation {
    if (this.connection.kind !== "jira") throw new Error("The project does not use Jira");
    const site = new URL(this.connection.site).origin;
    return IssueAssociationSchema.parse({ kind: "jira", site, id: row.id, key: row.key, title: issueText(row.fields.summary), url: `${site}/browse/${encodeURIComponent(row.key)}` });
  }

  private check(issue: IssueAssociation): void {
    if (issue.kind === "github" && this.connection.kind === "github" && issue.repository.toLowerCase() === this.connection.repository.toLowerCase()) return;
    if (issue.kind === "jira" && this.connection.kind === "jira" && new URL(issue.site).origin === new URL(this.connection.site).origin && issue.key.startsWith(`${this.connection.project}-`)) return;
    throw new IssueTrackerScopeFailure("The issue does not belong to the configured tracker");
  }

  async search(query: string): Promise<IssueAssociation[]> {
    const text = query.trim().slice(0, 200);
    if (this.connection.kind === "github") {
      const repository = this.connection.repository;
      const result = z.object({ items: z.array(githubIssue) }).parse(await this.github(`search/issues?q=${encodeURIComponent(`repo:${repository} is:issue ${text}`)}&per_page=30`));
      return result.items.filter(row => !row.pull_request).map(row => IssueAssociationSchema.parse({ kind: "github", repository, id: String(row.id), number: row.number, key: `#${row.number}`, title: row.title, url: row.html_url }));
    }
    if (new RegExp(`^${this.connection.project}-\\d+$`, "i").test(text)) return [this.reference(jiraIssue.parse(await this.jira(`/rest/api/3/issue/${encodeURIComponent(text)}?fields=summary`)))];
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const jql = `project = "${this.connection.project}"${escaped ? ` AND text ~ "${escaped}"` : ""} ORDER BY updated DESC`;
    const page = jiraPage.parse(await this.jira(`/rest/api/3/search/jql?${new URLSearchParams({ jql, fields: "summary", maxResults: "30" })}`));
    return page.issues.map(row => this.reference(row));
  }

  private async comments(issue: IssueAssociation): Promise<z.infer<typeof comment>[]> {
    this.check(issue);
    const result: z.infer<typeof comment>[] = [];
    for (let page = 0; page < 100; page++) {
      if (issue.kind === "github") {
        const rows = z.array(comment).parse(await this.github(`repos/${issue.repository}/issues/${issue.number}/comments?per_page=100&page=${page + 1}`));
        result.push(...rows);
        if (rows.length < 100) return result;
      } else {
        const rows = z.object({ comments: z.array(comment), total: z.number(), startAt: z.number() }).parse(await this.jira(`/rest/api/3/issue/${issue.id}/comment?maxResults=100&startAt=${result.length}`));
        result.push(...rows.comments);
        if (result.length >= rows.total) return result;
        if (!rows.comments.length) throw new Error("Jira returned an incomplete comment page");
      }
    }
    throw new Error("The issue has more comments than Suplex can load");
  }

  async read(issue: IssueAssociation): Promise<IssueContext> {
    this.check(issue);
    const comments = await this.comments(issue);
    let detail: string;
    let current: IssueAssociation = issue;
    if (issue.kind === "github") {
      const row = githubIssue.parse(await this.github(`repos/${issue.repository}/issues/${issue.number}`));
      if (row.pull_request) throw new Error("Select an issue, not a pull request");
      current = { ...issue, id: String(row.id), title: row.title, url: row.html_url };
      detail = row.body ?? "";
    } else {
      const row = jiraIssue.parse(await this.jira(`/rest/api/3/issue/${issue.id}?expand=names,schema`));
      current = this.reference(row);
      this.check(current);
      detail = Object.entries(row.fields).filter(([key, value]) => !["comment", "attachment", "issuelinks"].includes(key) && value !== null).map(([key, value]) => `${row.names?.[key] ?? key}: ${issueText(value)}`).join("\n\n");
      const attachments = z.array(attachment).parse(row.fields.attachment ?? []);
      const { origin, authorization } = this.jiraCredentials();
      for (const file of attachments.slice(0, 10)) {
        detail += `\n\nAttachment: ${file.filename} (${file.size} bytes)`;
        if (file.size > 256 * 1024 || !(file.mimeType?.startsWith("text/") || file.mimeType === "application/json")) {
          detail += `\nContent not loaded: binary or larger than 256 KiB. Review through ${origin}/secure/attachment/${file.id}/${encodeURIComponent(file.filename)}.`;
          continue;
        }
        try { detail += `\n${(await providerBytes(new URL(`/rest/api/3/attachment/content/${file.id}?redirect=false`, origin), origin, authorization, {}, this.request, 256 * 1024)).toString("utf8")}`; }
        catch { detail += "\nContent could not be read with this tracker connection."; }
      }
      if (attachments.length > 10) detail += `\n${attachments.length - 10} additional attachments were not loaded (10 attachment intake limit).`;
      const linked = z.array(z.object({ inwardIssue: z.object({ id: z.string(), key: z.string() }).optional(), outwardIssue: z.object({ id: z.string(), key: z.string() }).optional() })).parse(row.fields.issuelinks ?? []).flatMap(link => link.inwardIssue ?? link.outwardIssue ?? []);
      for (const link of linked.slice(0, 5)) {
        try {
          const related = jiraIssue.parse(await this.jira(`/rest/api/3/issue/${encodeURIComponent(link.id)}?fields=summary,description`));
          detail += `\n\nLinked issue ${related.key}: ${issueText(related.fields.summary)}\n${issueText(related.fields.description).slice(0, 20_000)}`;
          if (issueText(related.fields.description).length > 20_000) detail += "\nLinked description limited to 20000 characters.";
        } catch { detail += `\nLinked issue ${link.key} could not be read with this tracker connection.`; }
      }
      if (linked.length > 5) detail += `\n${linked.length - 5} linked issues were not loaded (5 linked issue intake limit).`;
    }
    const text = `${current.key}: ${current.title}\n${current.url}\n\n${detail}\n\nComments\n${comments.map(row => issueText(row.body)).join("\n\n")}`;
    return { issue: current, text: text.length > 500_000 ? `${text.slice(0, 500_000)}\n\nContext intake limit reached: additional content was not loaded. Inspect the linked issue before relying on this incomplete snapshot.` : text, capturedAt: new Date().toISOString() };
  }

  async publish(issue: IssueAssociation, taskId: string, body: string, beforeWrite: () => Promise<void> = async () => {}, knownCommentId?: string): Promise<string> {
    this.check(issue);
    const marker = `[Suplex task ${taskId}]`;
    const actor = await this.actor();
    const text = `${body}\n\n${marker}`;
    const owned = (await this.comments(issue)).filter(row => this.owned(row, actor));
    const existing = owned.find(row => String(row.id) === knownCommentId) ?? owned.find(row => {
      const value = issueText(row.body);
      if (value === text) return true;
      // Recover a complete Suplex evidence comment, never a human note quoting its marker.
      return value.startsWith("## What changed\n\n") && value.endsWith(`\n\n${marker}`)
        && /\n\nSource: [a-f0-9]{40,64}\n\n## Before\n\n[\s\S]*\n\n## After\n\n[\s\S]*\n\n## How to verify\n\n/i.test(value);
    });
    if (existing && issueText(existing.body) === text) return String(existing.id);
    let id: string;
    if (issue.kind === "github") {
      const path = existing ? `repos/${issue.repository}/issues/comments/${existing.id}` : `repos/${issue.repository}/issues/${issue.number}/comments`;
      await this.beforeMutation(issue, beforeWrite);
      const result = comment.parse(await this.github(path, { body: text }, existing ? "PATCH" : "POST"));
      id = String(result.id);
    } else {
      const document = jiraEvidenceDocument(text);
      const { origin, authorization } = this.jiraCredentials();
      const path = `/rest/api/3/issue/${issue.id}/comment${existing ? `/${existing.id}` : ""}`;
      await this.beforeMutation(issue, beforeWrite);
      const row = comment.parse(await providerJson(new URL(path, origin), origin, authorization, { method: existing ? "PUT" : "POST", body: JSON.stringify({ body: document }) }, this.request));
      id = String(row.id);
    }
    const observed = (await this.comments(issue)).find(row => String(row.id) === id && this.owned(row, actor));
    if (!observed || issueText(observed.body) !== text) throw new Error("The tracker has not confirmed the issue evidence comment");
    return id;
  }
}
