ALTER TABLE `forge_users` ADD COLUMN `identity_version` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `forge_invitations` ADD COLUMN `metadata_json` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `forge_sessions` ADD COLUMN `token_version` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `forge_invitations_one_active_bootstrap_or_recovery`
ON `forge_invitations` (`kind`)
WHERE `kind` IN ('bootstrap', 'recovery') AND `consumed_at` IS NULL AND `replaced_at` IS NULL;
