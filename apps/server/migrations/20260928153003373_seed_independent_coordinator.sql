INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, provider_instance_id, created_at, updated_at)
SELECT 'profile_native_independent', 'Independent Coordinator', 'root',
       '00000000000000000000000000000003', provider, model, reasoning_level,
       service_tier, provider_instance_id,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM suplex_profiles
WHERE id = 'profile_native_root' AND archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM suplex_profiles WHERE id = 'profile_native_independent' OR name = 'Independent Coordinator');
--> statement-breakpoint
WITH assignments(id, engine, path) AS (
  VALUES ('workflow_native_independent_review', 'independent_review', '$.advisorProfileIds.reviewer'),
         ('workflow_native_competing_plans', 'competing_plans', '$.advisorProfileIds.planner_b'),
         ('workflow_native_refine_pull_request', 'refine_pull_request', '$.advisorProfileIds.rater')
)
UPDATE suplex_workflows AS workflow
SET configuration_json = json_set(configuration_json, assignments.path, 'profile_native_independent'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM assignments
WHERE workflow.id = assignments.id AND workflow.engine = assignments.engine
  AND coalesce(json_extract(configuration_json, assignments.path), '') IN ('', 'profile_native_root')
  AND EXISTS (SELECT 1 FROM suplex_profiles WHERE id = 'profile_native_independent' AND role = 'root' AND archived_at IS NULL);
