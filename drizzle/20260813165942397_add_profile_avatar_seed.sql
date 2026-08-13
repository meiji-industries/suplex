ALTER TABLE `forge_profiles` ADD COLUMN `avatar_seed` text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `forge_profiles` SET `avatar_seed` = lower(hex(randomblob(16))) WHERE `avatar_seed` = '';
