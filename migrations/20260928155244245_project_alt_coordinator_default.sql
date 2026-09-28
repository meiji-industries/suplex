ALTER TABLE suplex_projects ADD COLUMN alt_profile_id TEXT NOT NULL DEFAULT 'profile_native_independent';
--> statement-breakpoint
-- Keep provider restrictions intact when assigning existing projects.
UPDATE suplex_projects AS project SET alt_profile_id = root_profile_id
WHERE NOT EXISTS (
  SELECT 1 FROM suplex_profiles AS profile
  WHERE profile.id = 'profile_native_independent' AND profile.role = 'root' AND profile.archived_at IS NULL
    AND (project.provider_policy_json IS NULL OR project.provider_policy_json = 'null'
      OR (profile.provider_instance_id IS NULL AND EXISTS (SELECT 1 FROM json_each(project.provider_policy_json, '$.allowedProviders') WHERE value = profile.provider))
      OR EXISTS (SELECT 1 FROM json_each(project.provider_policy_json, '$.allowedInstanceIds') WHERE value = profile.provider_instance_id))
);
--> statement-breakpoint
WITH assignments(id, engine, path) AS (
  VALUES ('workflow_native_independent_review', 'independent_review', '$.advisorProfileIds.reviewer'),
         ('workflow_native_competing_plans', 'competing_plans', '$.advisorProfileIds.planner_b'),
         ('workflow_native_refine_pull_request', 'refine_pull_request', '$.advisorProfileIds.rater')
)
UPDATE suplex_workflows AS workflow
SET configuration_json = json_remove(configuration_json, assignments.path),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM assignments
WHERE workflow.id = assignments.id AND workflow.engine = assignments.engine
  AND json_extract(configuration_json, assignments.path) = 'profile_native_independent';
