CREATE TABLE `forge_external_agents` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `avatar_seed` text NOT NULL,
  `company_id` text NOT NULL,
  `hermes_profile_id` text,
  `status` text NOT NULL DEFAULT 'pending',
  `paired_at` text,
  `last_used_at` text,
  `revoked_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `forge_external_agents_name_unique` UNIQUE(`name`),
  FOREIGN KEY (`company_id`) REFERENCES `forge_companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_external_agents_active_profile_unique` ON `forge_external_agents` (`hermes_profile_id`) WHERE `hermes_profile_id` IS NOT NULL AND `status` != 'revoked';
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_external_agents_company_identity_unique` ON `forge_external_agents` (`id`, `company_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_projects_company_identity_unique` ON `forge_projects` (`id`, `company_id`);
--> statement-breakpoint
CREATE TABLE `forge_external_agent_project_grants` (
  `agent_id` text NOT NULL,
  `company_id` text NOT NULL,
  `project_id` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`agent_id`, `project_id`),
  FOREIGN KEY (`agent_id`, `company_id`) REFERENCES `forge_external_agents`(`id`, `company_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`project_id`, `company_id`) REFERENCES `forge_projects`(`id`, `company_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `forge_hermes_pairing_codes` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `code_hash` text NOT NULL,
  `purpose` text NOT NULL,
  `expires_at` text NOT NULL,
  `consumed_at` text,
  `replaced_at` text,
  `created_at` text NOT NULL,
  CONSTRAINT `forge_hermes_pairing_codes_hash_unique` UNIQUE(`code_hash`),
  FOREIGN KEY (`agent_id`) REFERENCES `forge_external_agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_hermes_pairing_codes_active_agent_unique` ON `forge_hermes_pairing_codes` (`agent_id`) WHERE `consumed_at` IS NULL AND `replaced_at` IS NULL;
--> statement-breakpoint
CREATE TABLE `forge_external_agent_credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `credential_hash` text NOT NULL,
  `created_at` text NOT NULL,
  `last_used_at` text,
  `revoked_at` text,
  CONSTRAINT `forge_external_agent_credentials_hash_unique` UNIQUE(`credential_hash`),
  FOREIGN KEY (`agent_id`) REFERENCES `forge_external_agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_external_agent_credentials_active_agent_unique` ON `forge_external_agent_credentials` (`agent_id`) WHERE `revoked_at` IS NULL;
