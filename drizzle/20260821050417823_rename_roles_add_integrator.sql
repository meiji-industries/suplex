-- Roles become optional pipeline stages: analyst -> planner, implementer -> builder,
-- plus a new optional integrator that owns getting the Builder's branch merged.
-- forge_agents carries a CHECK on the role vocabulary, so it needs a table rebuild.
PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE `forge_external_agents_role_rename` AS SELECT * FROM `forge_external_agents`;
--> statement-breakpoint
CREATE TABLE `forge_external_agent_credentials_role_rename` AS SELECT * FROM `forge_external_agent_credentials`;
--> statement-breakpoint
CREATE TABLE `forge_agents_role_rename` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL DEFAULT 'internal',
  `name` text NOT NULL,
  `role` text,
  `avatar_seed` text NOT NULL,
  `profile_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `forge_agents_kind_name_unique` UNIQUE(`kind`, `name`),
  FOREIGN KEY (`profile_id`) REFERENCES `forge_profiles`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `forge_agents_kind_shape_check` CHECK (
    (`kind` = 'internal' AND `role` IN ('planner', 'reviewer', 'builder', 'integrator') AND `profile_id` IS NOT NULL) OR
    (`kind` = 'hermes' AND `role` IS NULL AND `profile_id` IS NULL)
  )
);
--> statement-breakpoint
INSERT INTO `forge_agents_role_rename` (`id`, `kind`, `name`, `role`, `avatar_seed`, `profile_id`, `created_at`, `updated_at`)
SELECT `id`, `kind`, `name`, CASE `role` WHEN 'analyst' THEN 'planner' WHEN 'implementer' THEN 'builder' ELSE `role` END, `avatar_seed`, `profile_id`, `created_at`, `updated_at` FROM `forge_agents`;
--> statement-breakpoint
DROP TABLE `forge_agents`;
--> statement-breakpoint
ALTER TABLE `forge_agents_role_rename` RENAME TO `forge_agents`;
--> statement-breakpoint
INSERT OR IGNORE INTO `forge_external_agents` SELECT * FROM `forge_external_agents_role_rename`;
--> statement-breakpoint
INSERT OR IGNORE INTO `forge_external_agent_credentials` SELECT * FROM `forge_external_agent_credentials_role_rename`;
--> statement-breakpoint
DROP TABLE `forge_external_agents_role_rename`;
--> statement-breakpoint
DROP TABLE `forge_external_agent_credentials_role_rename`;
--> statement-breakpoint
UPDATE `forge_tasks` SET `role_agents_json` = json_remove(json_set(`role_agents_json`, '$.planner', json_extract(`role_agents_json`, '$.analyst')), '$.analyst') WHERE json_extract(`role_agents_json`, '$.analyst') IS NOT NULL;
--> statement-breakpoint
UPDATE `forge_tasks` SET `role_agents_json` = json_remove(json_set(`role_agents_json`, '$.builder', json_extract(`role_agents_json`, '$.implementer')), '$.implementer') WHERE json_extract(`role_agents_json`, '$.implementer') IS NOT NULL;
--> statement-breakpoint
UPDATE `forge_projects` SET `role_defaults_json` = json_remove(json_set(`role_defaults_json`, '$.planner', json_extract(`role_defaults_json`, '$.analyst')), '$.analyst') WHERE json_extract(`role_defaults_json`, '$.analyst') IS NOT NULL;
--> statement-breakpoint
UPDATE `forge_projects` SET `role_defaults_json` = json_remove(json_set(`role_defaults_json`, '$.builder', json_extract(`role_defaults_json`, '$.implementer')), '$.implementer') WHERE json_extract(`role_defaults_json`, '$.implementer') IS NOT NULL;
--> statement-breakpoint
UPDATE `forge_agent_executions` SET `role` = 'planner' WHERE `role` = 'analyst';
--> statement-breakpoint
UPDATE `forge_agent_executions` SET `role` = 'builder' WHERE `role` = 'implementer';
--> statement-breakpoint
UPDATE `forge_capacity_requests` SET `role` = 'planner' WHERE `role` = 'analyst';
--> statement-breakpoint
UPDATE `forge_capacity_requests` SET `role` = 'builder' WHERE `role` = 'implementer';
