-- Existing installations may still have product-named usernames from the
-- pre-neutral identity format. Keep the physical table names stable, but make
-- the externally returned identifier neutral before new sessions are issued.
UPDATE `suplex_users`
SET `username` = 'user_v1_' || `id`, `identity_version` = 1
WHERE `identity_version` < 1;
--> statement-breakpoint
ALTER TABLE `suplex_sessions` ADD COLUMN `legacy_token_hash` text;
--> statement-breakpoint
ALTER TABLE `suplex_sessions` ADD COLUMN `legacy_token_expires_at` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suplex_sessions_legacy_token_hash_idx` ON `suplex_sessions` (`legacy_token_hash`);
