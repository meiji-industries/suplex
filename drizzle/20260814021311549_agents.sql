-- Write migration SQL here.
CREATE TABLE `forge_agents` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `role` text NOT NULL,
  `avatar_seed` text NOT NULL,
  `profile_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `forge_agents_name_unique` UNIQUE(`name`),
  FOREIGN KEY (`profile_id`) REFERENCES `forge_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO forge_agents (id, name, role, avatar_seed, profile_id, created_at, updated_at)
WITH pairs(role, profile_id) AS (
  SELECT 'analyst', json_extract(role_defaults_json, '$.lead') FROM forge_projects
  UNION SELECT 'implementer', json_extract(role_defaults_json, '$.developer') FROM forge_projects
  UNION SELECT 'reviewer', COALESCE(json_extract(role_defaults_json, '$.reviewer'), json_extract(role_defaults_json, '$.lead')) FROM forge_projects
  UNION SELECT 'analyst', json_extract(role_profiles_json, '$.lead') FROM forge_tasks
  UNION SELECT 'implementer', json_extract(role_profiles_json, '$.developer') FROM forge_tasks
  UNION SELECT 'reviewer', COALESCE(json_extract(role_profiles_json, '$.reviewer'), json_extract(role_profiles_json, '$.lead')) FROM forge_tasks
  UNION SELECT r.role, (SELECT MIN(id) FROM forge_profiles)
    FROM (SELECT 'analyst' AS role UNION SELECT 'implementer' UNION SELECT 'reviewer') AS r
),
distinct_pairs AS (
  SELECT DISTINCT p.role, p.profile_id FROM pairs p
  WHERE p.profile_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM forge_profiles fp WHERE fp.id = p.profile_id)
)
SELECT
  'agent_' || lower(hex(randomblob(12))),
  CASE p.role WHEN 'analyst' THEN 'Analyst' WHEN 'implementer' THEN 'Implementer' ELSE 'Reviewer' END
    || CASE WHEN COUNT(*) OVER (PARTITION BY p.role) > 1 THEN ' (' || pr.name || ')' ELSE '' END,
  p.role,
  COALESCE(NULLIF(pr.avatar_seed, ''), lower(hex(randomblob(16)))),
  p.profile_id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM distinct_pairs p JOIN forge_profiles pr ON pr.id = p.profile_id;
--> statement-breakpoint
ALTER TABLE `forge_tasks` RENAME COLUMN `role_profiles_json` TO `role_agents_json`;
--> statement-breakpoint
UPDATE forge_tasks SET role_agents_json = json_patch('{}', json_object(
  'analyst', (SELECT a.id FROM forge_agents a WHERE a.role = 'analyst' AND a.profile_id = json_extract(forge_tasks.role_agents_json, '$.lead') ORDER BY a.id LIMIT 1),
  'implementer', (SELECT a.id FROM forge_agents a WHERE a.role = 'implementer' AND a.profile_id = json_extract(forge_tasks.role_agents_json, '$.developer') ORDER BY a.id LIMIT 1),
  'reviewer', (SELECT a.id FROM forge_agents a WHERE a.role = 'reviewer' AND a.profile_id = COALESCE(json_extract(forge_tasks.role_agents_json, '$.reviewer'), json_extract(forge_tasks.role_agents_json, '$.lead')) ORDER BY a.id LIMIT 1)
));
--> statement-breakpoint
UPDATE forge_projects SET role_defaults_json = json_patch('{}', json_object(
  'analyst', (SELECT a.id FROM forge_agents a WHERE a.role = 'analyst' AND a.profile_id = json_extract(forge_projects.role_defaults_json, '$.lead') ORDER BY a.id LIMIT 1),
  'implementer', (SELECT a.id FROM forge_agents a WHERE a.role = 'implementer' AND a.profile_id = json_extract(forge_projects.role_defaults_json, '$.developer') ORDER BY a.id LIMIT 1),
  'reviewer', (SELECT a.id FROM forge_agents a WHERE a.role = 'reviewer' AND a.profile_id = COALESCE(json_extract(forge_projects.role_defaults_json, '$.reviewer'), json_extract(forge_projects.role_defaults_json, '$.lead')) ORDER BY a.id LIMIT 1)
));
--> statement-breakpoint
ALTER TABLE `forge_projects` DROP COLUMN `allowed_profiles_json`;
--> statement-breakpoint
UPDATE forge_agent_executions SET role = 'analyst' WHERE role = 'lead';
--> statement-breakpoint
UPDATE forge_capacity_requests SET role = 'analyst' WHERE role = 'lead';
--> statement-breakpoint
UPDATE forge_capacity_requests SET role = 'implementer' WHERE role = 'developer';
--> statement-breakpoint
ALTER TABLE `forge_profiles` DROP COLUMN `avatar_seed`;
