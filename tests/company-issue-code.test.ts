import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { insertNativeTaskRow } from "./helpers/native-task-row.js";

const now = "2026-08-12T00:00:00.000Z";

function insertIssue(database: ForgeDatabase, companyId: string, suffix: string): void {
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, setup_command, verification_command, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'main', 'true', 'true', ?, ?)").run(`project-${suffix}`, companyId, `Project ${suffix}`, `/repo/${suffix}`, `/worktrees/${suffix}`, now, now);
    insertNativeTaskRow(db, { taskId: `task-${suffix}`, companyId, projectId: `project-${suffix}` });
  });
}

test("company issue codes normalize, lock after allocation, and audit real changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-company-issue-code-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('member', 'Member', 'member', 'member', 'active', ?, ?)").run(now, now);
    });
    const auth = new AuthService(database, createTestConfig(root));
    const editable = auth.createCompany("admin", "Editable");
    expect(editable.issueCode).toBeNull();
    expect(auth.setCompanyIssueCode("admin", editable.id, "  ad4m ").issueCode).toBe("AD4M");
    expect(auth.setCompanyIssueCode("admin", editable.id, "beta").issueCode).toBe("BETA");
    expect(auth.setCompanyIssueCode("admin", editable.id, null).issueCode).toBeNull();
    await expect(Promise.resolve().then(() => auth.setCompanyIssueCode("member", editable.id, "NOPE"))).rejects.toMatchObject({ statusCode: 404 });
    for (const invalid of ["A", "1A", "A_B", "ABCDEFGHIJK"]) {
      expect(() => auth.setCompanyIssueCode("admin", editable.id, invalid)).toThrow(/Issue code must/);
    }

    auth.setCompanyIssueCode("admin", editable.id, "LOCK");
    insertIssue(database, editable.id, "locked");
    expect(auth.setCompanyIssueCode("admin", editable.id, " lock ").issueCode).toBe("LOCK");
    expect(() => auth.setCompanyIssueCode("admin", editable.id, "OTHER")).toThrowError(expect.objectContaining({ statusCode: 409 }));
    expect(() => auth.setCompanyIssueCode("admin", editable.id, null)).toThrowError(expect.objectContaining({ statusCode: 409 }));

    const existing = auth.createCompany("admin", "Existing issues");
    insertIssue(database, existing.id, "existing");
    expect(auth.setCompanyIssueCode("admin", existing.id, "same").issueCode).toBe("SAME");
    const other = auth.createCompany("admin", "Other tenant");
    expect(auth.setCompanyIssueCode("admin", other.id, "same").issueCode).toBe("SAME");

    const events = auth.listAuditEvents("admin").filter((event) => event.action === "company_issue_code_updated" && event.companyId === existing.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({ previousIssueCode: "", newIssueCode: "SAME" });
    expect(auth.setCompanyIssueCode("admin", existing.id, "same").issueCode).toBe("SAME");
    expect(auth.listAuditEvents("admin").filter((event) => event.action === "company_issue_code_updated" && event.companyId === existing.id)).toHaveLength(1);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
