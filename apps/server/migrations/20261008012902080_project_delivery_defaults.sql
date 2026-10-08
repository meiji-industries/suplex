-- Project delivery defaults become first-class columns; the rest of the agent task policy is removed.
ALTER TABLE suplex_projects ADD COLUMN delivery_target text NOT NULL DEFAULT 'pull_request_draft';
--> statement-breakpoint
ALTER TABLE suplex_projects ADD COLUMN run_project_tests integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE suplex_projects ADD COLUMN visual_evidence text NOT NULL DEFAULT 'off';
--> statement-breakpoint
UPDATE suplex_projects
SET
  delivery_target = CASE
    WHEN json_extract(agent_task_policy_json, '$.deliveryTarget') IN ('local_worktree', 'remote_branch', 'pull_request_draft', 'pull_request_ready', 'merged')
      THEN json_extract(agent_task_policy_json, '$.deliveryTarget')
    ELSE 'pull_request_draft'
  END,
  run_project_tests = CASE
    WHEN json_type(agent_task_policy_json, '$.runProjectTests') IN ('false')
      OR (json_type(agent_task_policy_json, '$.runProjectTests') = 'integer' AND json_extract(agent_task_policy_json, '$.runProjectTests') = 0)
      THEN 0
    ELSE 1
  END,
  visual_evidence = CASE
    WHEN json_extract(agent_task_policy_json, '$.visualEvidence') IN ('off', 'capture', 'required')
      THEN json_extract(agent_task_policy_json, '$.visualEvidence')
    ELSE 'off'
  END
WHERE json_valid(agent_task_policy_json);
--> statement-breakpoint
ALTER TABLE suplex_projects DROP COLUMN agent_task_policy_json;
