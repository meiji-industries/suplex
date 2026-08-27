import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { BrowserProofFailure, BrowserProofService } from "../src/browser-proof.js";
import { ForgeDatabase } from "../src/database.js";
import { runCommand } from "../src/command-runner.js";

const commit = "a".repeat(40), tree = "b".repeat(40);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.alloc(17), Buffer.from([0, 0, 0, 0]), Buffer.from("IEND"), Buffer.alloc(4)]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02, 0xff, 0xda, 0x00, 0x02, 1, 2, 3, 4, 0xff, 0xd9]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([12, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(4)]);
function paddedPng(size: number): Buffer { const bytes = Buffer.alloc(size); png.subarray(0, 33).copy(bytes); Buffer.from([0, 0, 0, 0]).copy(bytes, size - 12); Buffer.from("IEND").copy(bytes, size - 8); return bytes; }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-proof-")), worktree = join(root, "worktree"), proof = join(worktree, ".forge-proof"), artifactRoot = join(root, "artifacts");
  await mkdir(proof, { recursive: true });
  await writeFile(join(worktree, "README.md"), "fixture\n");
  for (const args of [["init"], ["config", "user.email", "forge@example.invalid"], ["config", "user.name", "Forge"], ["add", "README.md"], ["commit", "-m", "fixture"]]) { const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd: worktree }); if (result.exitCode !== 0) throw new Error(result.stderr); }
  const database = new ForgeDatabase(join(root, "forge.sqlite")), artifacts = new ArtifactStore(artifactRoot, database), service = new BrowserProofService(database, artifacts);
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-1', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', ?, ?, 'acme/forge', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(worktree, worktree, now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-1', 'company-1', 'task-brief', 'task.md', 'text/markdown', 1, ?, 'company-1/brief.bin', ?)").run("0".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-1', 'company-1', 'project-1', 'Task', 'brief-1', '[]', '{}', 0, 'workflow-1', 'revision-1', 'proof-fixture', ?, ?)").run(now, now);
  });
  const ingest = (evidence: Parameters<BrowserProofService["ingest"]>[0]["evidence"], overrides: Partial<Parameters<BrowserProofService["ingest"]>[0]> = {}) => service.ingest({ taskId: "task-1", companyId: "company-1", developerExecutionId: "developer-1", resultCommit: commit, resultTree: tree, worktreePath: worktree, control: "required", ...(evidence ? { evidence } : {}), ...overrides });
  return { root, worktree, proof, artifactRoot, database, artifacts, service, ingest };
}

test("ingests structured PNG/JPEG/WebP proof and retries without duplicates", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.proof, "screen.png"), png); await writeFile(join(value.proof, "photo.jpg"), jpeg); await writeFile(join(value.proof, "view.webp"), webp);
    const evidence = { captured: true, summary: "Desktop and narrow", captures: [{ path: ".forge-proof/screen.png", caption: "Desktop", viewport: { width: 1440, height: 900, deviceScaleFactor: 2 }, capturedAt: "2026-08-26T12:00:00.000Z" }, { path: ".forge-proof/photo.jpg" }, { path: ".forge-proof/view.webp" }] };
    const first = await value.ingest(evidence), second = await value.ingest(evidence);
    expect(second).toEqual(first);
    const rows = value.database.authQuery((db) => db.prepare("SELECT kind, task_id, company_id FROM forge_artifacts WHERE kind LIKE 'browser-proof-%' ORDER BY kind").all() as Array<{ kind: string; task_id: string; company_id: string }>);
    expect(rows).toHaveLength(4); expect(rows.every((row) => row.task_id === "task-1" && row.company_id === "company-1")).toBe(true);
    expect(value.service.projectSync("task-1", "company-1")[0]?.images.map((image) => image.mimeType)).toEqual(["image/png", "image/jpeg", "image/webp"]);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("enforces mode, staging path, regular-file, symlink, count, and metadata boundaries", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.proof, "ok.png"), png); await writeFile(join(value.root, "outside.png"), png); await symlink(join(value.root, "outside.png"), join(value.proof, "escape.png"));
    await expect(value.ingest(undefined)).rejects.toMatchObject({ code: "proof-required" });
    await expect(value.ingest({ captured: true, paths: ["../outside.png"] })).rejects.toBeInstanceOf(BrowserProofFailure);
    await expect(value.ingest({ captured: true, paths: [".forge-proof/escape.png"] })).rejects.toBeInstanceOf(BrowserProofFailure);
    await expect(value.ingest({ captured: false, paths: [".forge-proof/ok.png"] })).rejects.toMatchObject({ code: "invalid-proof" });
    await expect(value.ingest({ captured: true, paths: Array.from({ length: 9 }, (_, index) => `.forge-proof/${index}.png`) } as never)).rejects.toBeTruthy();
    await expect(value.ingest({ captured: true, captures: [{ path: ".forge-proof/ok.png", viewport: { width: 0, height: 900 } }] } as never)).rejects.toBeTruthy();
    await expect(value.ingest(undefined, { control: "capture" })).resolves.toBeUndefined();
    await expect(value.ingest({ captured: true, paths: [".forge-proof/ok.png"] }, { control: "off" })).resolves.toBeUndefined();
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("rejects spoofed and truncated image structures", async () => {
  const value = await fixture();
  try {
    for (const [name, bytes] of [["text.png", Buffer.from("not an image")], ["short.png", png.subarray(0, 24)], ["short.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])], ["short.webp", Buffer.concat([Buffer.from("RIFF"), Buffer.from([8, 0, 0, 0]), Buffer.from("WEBP")])]] as const) {
      await writeFile(join(value.proof, name), bytes);
      await expect(value.ingest({ captured: true, paths: [`.forge-proof/${name}`] })).rejects.toMatchObject({ code: "invalid-proof" });
    }
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("rejects tracked proof and per-file or aggregate overflow", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.proof, "tracked.png"), png); const add = await runCommand({ taskId: null, stepId: null, command: "git", args: ["add", ".forge-proof/tracked.png"], cwd: value.worktree }); expect(add.exitCode).toBe(0);
    await expect(value.ingest({ captured: true, paths: [".forge-proof/tracked.png"] })).rejects.toMatchObject({ code: "invalid-proof" });
    await writeFile(join(value.proof, "large.png"), paddedPng(5 * 1024 * 1024 + 1));
    await expect(value.ingest({ captured: true, paths: [".forge-proof/large.png"] })).rejects.toMatchObject({ code: "proof-too-large" });
    const paths: string[] = [];
    for (let index = 0; index < 6; index++) { const name = `.forge-proof/aggregate-${index}.png`; paths.push(name); await writeFile(join(value.worktree, name), paddedPng(4_500_000)); }
    await expect(value.ingest({ captured: true, paths })).rejects.toMatchObject({ code: "proof-too-large" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("off and empty capture preserve staging while successful cleanup removes only reported files", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.proof, "reported.png"), png); await writeFile(join(value.proof, "sibling.txt"), "keep");
    await expect(value.ingest(undefined, { control: "off" })).resolves.toBeUndefined(); expect(await readFile(join(value.proof, "sibling.txt"), "utf8")).toBe("keep");
    await expect(value.ingest(undefined, { control: "capture" })).resolves.toBeUndefined(); expect(await readFile(join(value.proof, "reported.png"))).toEqual(png);
    const evidence = { captured: true, captures: [{ path: ".forge-proof/reported.png" }] }, durable = await value.ingest(evidence, { control: "capture" });
    await value.service.cleanupPersisted(value.worktree, evidence, durable!);
    await expect(access(join(value.proof, "reported.png"))).rejects.toBeTruthy(); expect(await readFile(join(value.proof, "sibling.txt"), "utf8")).toBe("keep");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("reuses verified durable proof after cleanup and rejects report metadata drift", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.proof, "retry.png"), png);
    const evidence = { captured: true, summary: "Retry proof", captures: [{ path: ".forge-proof/retry.png", caption: "Desktop", viewport: { width: 1440, height: 900, deviceScaleFactor: 2 }, capturedAt: "2026-08-26T12:00:00.000Z" }] };
    const first = await value.ingest(evidence), before = value.database.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM forge_artifacts WHERE kind LIKE 'browser-proof-%'").get() as { count: number }).count);
    await value.service.cleanupPersisted(value.worktree, evidence, first!);
    const retry = await value.ingest(evidence), after = value.database.authQuery((db) => (db.prepare("SELECT COUNT(*) AS count FROM forge_artifacts WHERE kind LIKE 'browser-proof-%'").get() as { count: number }).count);
    expect(retry).toEqual(first); expect(after).toBe(before);
    await expect(value.ingest({ ...evidence, captures: [{ ...evidence.captures[0]!, caption: "Changed" }] })).rejects.toMatchObject({ code: "proof-identity-conflict" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("rejects wrong embedded bindings and tampered bytes from projection and download", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.proof, "ok.png"), png);
    const durable = await value.ingest({ captured: true, paths: [".forge-proof/ok.png"] });
    const imageId = durable!.artifactIds[0]!, manifestId = durable!.manifestArtifactId;
    expect(value.service.readForDownload("task-1", "company-1", imageId)?.bytes).toEqual(png);
    expect(value.service.readForDownload("task-other", "company-1", imageId)).toBeUndefined();
    expect(value.service.readForDownload("task-1", "company-other", imageId)).toBeUndefined();
    const imageRow = value.database.authQuery((db) => db.prepare("SELECT storage_path FROM forge_artifacts WHERE id = ?").get(imageId) as { storage_path: string });
    await writeFile(join(value.artifactRoot, imageRow.storage_path), Buffer.from("tampered"));
    expect(value.service.projectSync("task-1", "company-1")).toEqual([]);
    expect(() => value.service.readForDownload("task-1", "company-1", imageId)).toThrow(BrowserProofFailure);

    await writeFile(join(value.artifactRoot, imageRow.storage_path), png);
    const manifestRow = value.database.authQuery((db) => db.prepare("SELECT storage_path FROM forge_artifacts WHERE id = ?").get(manifestId) as { storage_path: string });
    const manifestPath = join(value.artifactRoot, manifestRow.storage_path), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const wrong = Buffer.from(JSON.stringify({ ...manifest, taskId: "task-other", companyId: "company-other" }));
    await writeFile(manifestPath, wrong); value.database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET sha256 = ?, byte_size = ? WHERE id = ?").run(createHash("sha256").update(wrong).digest("hex"), wrong.length, manifestId));
    expect(value.service.projectSync("task-1", "company-1")).toEqual([]);
    await expect(value.service.verifyDurableReference({ taskId: "task-1", companyId: "company-1", developerExecutionId: "developer-1", resultCommit: commit, resultTree: tree, manifestArtifactId: manifestId })).resolves.toBe(false);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
