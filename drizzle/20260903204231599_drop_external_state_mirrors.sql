CREATE TABLE forge_issue_worktrees_next (
  id text PRIMARY KEY NOT NULL,
  task_id text NOT NULL,
  company_id text NOT NULL,
  project_id text NOT NULL,
  workflow_id text NOT NULL,
  repository_path text NOT NULL,
  worktree_root text NOT NULL,
  worktree_path text NOT NULL,
  branch_name text NOT NULL,
  starting_sha text NOT NULL,
  lease_token_hash text NOT NULL,
  legacy integer NOT NULL DEFAULT 0,
  reserved_at text NOT NULL,
  activated_at text,
  released_at text,
  failure_code text,
  failure_summary text,
  FOREIGN KEY (task_id) REFERENCES forge_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES forge_companies(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES forge_projects(id) ON DELETE CASCADE,
  CONSTRAINT forge_issue_worktrees_legacy_check CHECK (legacy IN (0, 1))
);
--> statement-breakpoint
INSERT INTO forge_issue_worktrees_next (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, legacy, reserved_at, activated_at, released_at, failure_code, failure_summary)
  SELECT id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, legacy, reserved_at, activated_at, released_at, failure_code, failure_summary FROM forge_issue_worktrees;
--> statement-breakpoint
DROP TABLE forge_issue_worktrees;
--> statement-breakpoint
ALTER TABLE forge_issue_worktrees_next RENAME TO forge_issue_worktrees;
--> statement-breakpoint
CREATE INDEX forge_issue_worktrees_task_observed_idx ON forge_issue_worktrees (task_id, reserved_at);
--> statement-breakpoint
CREATE INDEX forge_issue_worktrees_branch_observed_idx ON forge_issue_worktrees (branch_name, reserved_at);
--> statement-breakpoint
CREATE INDEX forge_issue_worktrees_path_observed_idx ON forge_issue_worktrees (worktree_path, reserved_at);
--> statement-breakpoint
ALTER TABLE forge_releases DROP COLUMN status;
--> statement-breakpoint
ALTER TABLE forge_provider_operations DROP COLUMN status;
