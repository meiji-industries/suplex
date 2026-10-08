ALTER TABLE `suplex_agents` ADD COLUMN `kind` text NOT NULL DEFAULT 'external' CHECK (`kind` = 'external');
--> statement-breakpoint
DROP INDEX `suplex_external_agents_active_profile_unique`;
--> statement-breakpoint
ALTER TABLE `suplex_external_agents` RENAME COLUMN `hermes_profile_id` TO `client_profile_id`;
--> statement-breakpoint
DROP INDEX `suplex_hermes_pairing_codes_active_agent_unique`;
--> statement-breakpoint
ALTER TABLE `suplex_hermes_pairing_codes` RENAME TO `suplex_external_agent_pairing_codes`;
--> statement-breakpoint
CREATE UNIQUE INDEX `suplex_external_agent_pairing_codes_active_agent_unique` ON `suplex_external_agent_pairing_codes` (`agent_id`) WHERE `consumed_at` IS NULL AND `replaced_at` IS NULL;
