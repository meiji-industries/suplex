CREATE TABLE `suplex_external_agent_project_grants_preserved` (
  `agent_id` text NOT NULL,
  `company_id` text NOT NULL,
  `project_id` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `suplex_external_agent_project_grants_preserved` (`agent_id`, `company_id`, `project_id`, `created_at`)
SELECT `agent_id`, `company_id`, `project_id`, `created_at` FROM `suplex_external_agent_project_grants`;
--> statement-breakpoint
CREATE TABLE `suplex_hermes_pairing_codes_preserved` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `code_hash` text NOT NULL,
  `purpose` text NOT NULL,
  `expires_at` text NOT NULL,
  `consumed_at` text,
  `replaced_at` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `suplex_hermes_pairing_codes_preserved` (`id`, `agent_id`, `code_hash`, `purpose`, `expires_at`, `consumed_at`, `replaced_at`, `created_at`)
SELECT `id`, `agent_id`, `code_hash`, `purpose`, `expires_at`, `consumed_at`, `replaced_at`, `created_at` FROM `suplex_hermes_pairing_codes`;
--> statement-breakpoint
CREATE TABLE `suplex_external_agent_credentials_preserved` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `credential_hash` text NOT NULL,
  `created_at` text NOT NULL,
  `last_used_at` text,
  `revoked_at` text
);
--> statement-breakpoint
INSERT INTO `suplex_external_agent_credentials_preserved` (`id`, `agent_id`, `credential_hash`, `created_at`, `last_used_at`, `revoked_at`)
SELECT `id`, `agent_id`, `credential_hash`, `created_at`, `last_used_at`, `revoked_at` FROM `suplex_external_agent_credentials`;
--> statement-breakpoint
CREATE TABLE `suplex_agents_new` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL DEFAULT 'internal',
  `name` text NOT NULL,
  `role` text,
  `avatar_seed` text NOT NULL,
  `profile_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `suplex_agents_kind_name_unique` UNIQUE(`kind`, `name`),
  FOREIGN KEY (`profile_id`) REFERENCES `suplex_profiles`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT `suplex_agents_kind_shape_check` CHECK (
    (`kind` = 'internal' AND `role` IN ('analyst', 'implementer', 'reviewer') AND `profile_id` IS NOT NULL) OR
    (`kind` = 'hermes' AND `role` IS NULL AND `profile_id` IS NULL)
  )
);
--> statement-breakpoint
INSERT INTO `suplex_agents_new` (`id`, `kind`, `name`, `role`, `avatar_seed`, `profile_id`, `created_at`, `updated_at`)
SELECT `id`, 'internal', `name`, `role`, `avatar_seed`, `profile_id`, `created_at`, `updated_at` FROM `suplex_agents`;
--> statement-breakpoint
INSERT INTO `suplex_agents_new` (`id`, `kind`, `name`, `role`, `avatar_seed`, `profile_id`, `created_at`, `updated_at`)
SELECT `id`, 'hermes', `name`, NULL, `avatar_seed`, NULL, `created_at`, `updated_at` FROM `suplex_external_agents`
;
--> statement-breakpoint
DROP TABLE `suplex_agents`;
--> statement-breakpoint
ALTER TABLE `suplex_agents_new` RENAME TO `suplex_agents`;
--> statement-breakpoint
CREATE TABLE `suplex_external_agents_new` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL,
  `hermes_profile_id` text,
  `status` text NOT NULL DEFAULT 'pending',
  `paired_at` text,
  `last_used_at` text,
  `revoked_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `suplex_external_agents_status_check` CHECK (`status` IN ('pending', 'paired', 'revoked')),
  FOREIGN KEY (`id`) REFERENCES `suplex_agents`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `suplex_external_agents_new` (`id`, `company_id`, `hermes_profile_id`, `status`, `paired_at`, `last_used_at`, `revoked_at`, `created_at`, `updated_at`)
SELECT `id`, `company_id`, `hermes_profile_id`, `status`, `paired_at`, `last_used_at`, `revoked_at`, `created_at`, `updated_at` FROM `suplex_external_agents`;
--> statement-breakpoint
DROP TABLE `suplex_external_agent_project_grants`;
--> statement-breakpoint
DROP TABLE `suplex_hermes_pairing_codes`;
--> statement-breakpoint
DROP TABLE `suplex_external_agent_credentials`;
--> statement-breakpoint
DROP TABLE `suplex_external_agents`;
--> statement-breakpoint
ALTER TABLE `suplex_external_agents_new` RENAME TO `suplex_external_agents`;
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_external_agents_active_profile_unique` ON `suplex_external_agents` (`hermes_profile_id`) WHERE `hermes_profile_id` IS NOT NULL AND `status` != 'revoked';
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_external_agents_company_identity_unique` ON `suplex_external_agents` (`id`, `company_id`);
--> statement-breakpoint
CREATE TABLE `suplex_external_agent_project_grants` (
  `agent_id` text NOT NULL,
  `company_id` text NOT NULL,
  `project_id` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`agent_id`, `project_id`),
  FOREIGN KEY (`agent_id`, `company_id`) REFERENCES `suplex_external_agents`(`id`, `company_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`, `company_id`) REFERENCES `suplex_projects`(`id`, `company_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `suplex_hermes_pairing_codes` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `code_hash` text NOT NULL,
  `purpose` text NOT NULL,
  `expires_at` text NOT NULL,
  `consumed_at` text,
  `replaced_at` text,
  `created_at` text NOT NULL,
  CONSTRAINT `suplex_hermes_pairing_codes_hash_unique` UNIQUE(`code_hash`),
  FOREIGN KEY (`agent_id`) REFERENCES `suplex_external_agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_hermes_pairing_codes_active_agent_unique` ON `suplex_hermes_pairing_codes` (`agent_id`) WHERE `consumed_at` IS NULL AND `replaced_at` IS NULL;
--> statement-breakpoint
CREATE TABLE `suplex_external_agent_credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `credential_hash` text NOT NULL,
  `created_at` text NOT NULL,
  `last_used_at` text,
  `revoked_at` text,
  CONSTRAINT `suplex_external_agent_credentials_hash_unique` UNIQUE(`credential_hash`),
  FOREIGN KEY (`agent_id`) REFERENCES `suplex_external_agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_external_agent_credentials_active_agent_unique` ON `suplex_external_agent_credentials` (`agent_id`) WHERE `revoked_at` IS NULL;
--> statement-breakpoint
INSERT INTO `suplex_external_agent_project_grants` (`agent_id`, `company_id`, `project_id`, `created_at`)
SELECT `agent_id`, `company_id`, `project_id`, `created_at` FROM `suplex_external_agent_project_grants_preserved`;
--> statement-breakpoint
INSERT INTO `suplex_hermes_pairing_codes` (`id`, `agent_id`, `code_hash`, `purpose`, `expires_at`, `consumed_at`, `replaced_at`, `created_at`)
SELECT `id`, `agent_id`, `code_hash`, `purpose`, `expires_at`, `consumed_at`, `replaced_at`, `created_at` FROM `suplex_hermes_pairing_codes_preserved`;
--> statement-breakpoint
INSERT INTO `suplex_external_agent_credentials` (`id`, `agent_id`, `credential_hash`, `created_at`, `last_used_at`, `revoked_at`)
SELECT `id`, `agent_id`, `credential_hash`, `created_at`, `last_used_at`, `revoked_at` FROM `suplex_external_agent_credentials_preserved`;
--> statement-breakpoint
DROP TABLE `suplex_external_agent_project_grants_preserved`;
--> statement-breakpoint
DROP TABLE `suplex_hermes_pairing_codes_preserved`;
--> statement-breakpoint
DROP TABLE `suplex_external_agent_credentials_preserved`;
--> statement-breakpoint
CREATE TABLE `suplex_audit_events_new` (
  `id` text PRIMARY KEY NOT NULL,
  `actor_user_id` text,
  `actor_agent_id` text,
  `action` text NOT NULL,
  `target_user_id` text,
  `company_id` text,
  `metadata_json` text NOT NULL,
  `created_at` text NOT NULL,
  CONSTRAINT `suplex_audit_events_actor_check` CHECK (`actor_user_id` IS NULL OR `actor_agent_id` IS NULL),
  FOREIGN KEY (`actor_user_id`) REFERENCES `suplex_users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`actor_agent_id`) REFERENCES `suplex_agents`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`target_user_id`) REFERENCES `suplex_users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `suplex_audit_events_new` (`id`, `actor_user_id`, `actor_agent_id`, `action`, `target_user_id`, `company_id`, `metadata_json`, `created_at`)
SELECT `id`, `actor_user_id`, NULL, `action`, `target_user_id`, `company_id`, `metadata_json`, `created_at` FROM `suplex_audit_events`;
--> statement-breakpoint
DROP TABLE `suplex_audit_events`;
--> statement-breakpoint
ALTER TABLE `suplex_audit_events_new` RENAME TO `suplex_audit_events`;
--> statement-breakpoint
ALTER TABLE `suplex_tasks` ADD COLUMN `creator_agent_id` text REFERENCES `suplex_agents`(`id`) ON UPDATE no action ON DELETE no action;
--> statement-breakpoint
CREATE INDEX `suplex_tasks_creator_agent_project_idx` ON `suplex_tasks` (`creator_agent_id`, `project_id`);
--> statement-breakpoint
ALTER TABLE `suplex_task_creation_intents` ADD COLUMN `creator_agent_id` text REFERENCES `suplex_agents`(`id`) ON UPDATE no action ON DELETE no action;
