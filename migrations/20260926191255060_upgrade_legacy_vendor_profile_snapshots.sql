-- Profile snapshots written before 20260915211646874_providers_are_harnesses
-- carry the OpenCode vendor as provider. The TypeScript backend upgraded them
-- on read; rewrite them once so every reader sees a harness provider:
-- {"provider":"openai","model":"gpt-5"} becomes {"provider":"opencode","model":"openai/gpt-5"}.
UPDATE suplex_task_controls
SET root_profile_json = json_set(root_profile_json, '$.provider', 'opencode', '$.model', json_extract(root_profile_json, '$.provider') || '/' || json_extract(root_profile_json, '$.model'))
WHERE json_extract(root_profile_json, '$.provider') NOT IN ('opencode', 'claude-code', 'devin', 'codex') AND json_type(root_profile_json, '$.model') = 'text';
--> statement-breakpoint
UPDATE suplex_task_controls
SET worker_profile_json = json_set(worker_profile_json, '$.provider', 'opencode', '$.model', json_extract(worker_profile_json, '$.provider') || '/' || json_extract(worker_profile_json, '$.model'))
WHERE json_extract(worker_profile_json, '$.provider') NOT IN ('opencode', 'claude-code', 'devin', 'codex') AND json_type(worker_profile_json, '$.model') = 'text';
--> statement-breakpoint
UPDATE suplex_task_controls
SET advisor_profiles_json = (
  SELECT json_group_object(key, json(CASE
    WHEN json_extract(value, '$.provider') NOT IN ('opencode', 'claude-code', 'devin', 'codex') AND json_type(value, '$.model') = 'text'
    THEN json_set(value, '$.provider', 'opencode', '$.model', json_extract(value, '$.provider') || '/' || json_extract(value, '$.model'))
    ELSE value END))
  FROM json_each(advisor_profiles_json))
WHERE EXISTS (SELECT 1 FROM json_each(advisor_profiles_json) WHERE type = 'object' AND json_extract(value, '$.provider') NOT IN ('opencode', 'claude-code', 'devin', 'codex') AND json_type(value, '$.model') = 'text');
--> statement-breakpoint
UPDATE suplex_task_sessions
SET profile_json = json_set(profile_json, '$.provider', 'opencode', '$.model', json_extract(profile_json, '$.provider') || '/' || json_extract(profile_json, '$.model'))
WHERE json_extract(profile_json, '$.provider') NOT IN ('opencode', 'claude-code', 'devin', 'codex') AND json_type(profile_json, '$.model') = 'text';
--> statement-breakpoint
UPDATE suplex_github_trigger_dispatches
SET profiles_json = json_set(profiles_json, '$.root.provider', 'opencode', '$.root.model', json_extract(profiles_json, '$.root.provider') || '/' || json_extract(profiles_json, '$.root.model'))
WHERE json_extract(profiles_json, '$.root.provider') NOT IN ('opencode', 'claude-code', 'devin', 'codex') AND json_type(profiles_json, '$.root.model') = 'text';
--> statement-breakpoint
UPDATE suplex_github_trigger_dispatches
SET profiles_json = json_set(profiles_json, '$.worker.provider', 'opencode', '$.worker.model', json_extract(profiles_json, '$.worker.provider') || '/' || json_extract(profiles_json, '$.worker.model'))
WHERE json_extract(profiles_json, '$.worker.provider') NOT IN ('opencode', 'claude-code', 'devin', 'codex') AND json_type(profiles_json, '$.worker.model') = 'text';
--> statement-breakpoint
UPDATE suplex_github_trigger_dispatches
SET profiles_json = json_set(profiles_json, '$.advisors', json((
  SELECT json_group_object(key, json(CASE
    WHEN json_extract(value, '$.provider') NOT IN ('opencode', 'claude-code', 'devin', 'codex') AND json_type(value, '$.model') = 'text'
    THEN json_set(value, '$.provider', 'opencode', '$.model', json_extract(value, '$.provider') || '/' || json_extract(value, '$.model'))
    ELSE value END))
  FROM json_each(profiles_json, '$.advisors'))))
WHERE EXISTS (SELECT 1 FROM json_each(profiles_json, '$.advisors') WHERE type = 'object' AND json_extract(value, '$.provider') NOT IN ('opencode', 'claude-code', 'devin', 'codex') AND json_type(value, '$.model') = 'text');
