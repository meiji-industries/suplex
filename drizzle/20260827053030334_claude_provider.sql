CREATE TABLE `forge_herdr_role_sessions_new` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `session_role` text NOT NULL CHECK (`session_role` IN ('lead', 'developer', 'reviewer')),
  `generation` integer NOT NULL CHECK (`generation` >= 0),
  `is_current` integer NOT NULL DEFAULT 1 CHECK (`is_current` IN (0, 1)),
  `provider_kind` text NOT NULL CHECK (`provider_kind` IN ('codex', 'claude')),
  `codex_session_id` text UNIQUE,
  `agent_name` text,
  `pane_id` text,
  `rollout_path` text,
  `launch_fingerprint` text,
  `guard_directory` text,
  `status` text NOT NULL CHECK (`status` IN ('unbound', 'starting', 'ready', 'working', 'blocked', 'missing', 'closed', 'failed')),
  `last_agent_status` text,
  `attention_activated_at` text,
  `ensure_token` text,
  `ensure_expires_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `last_seen_at` text,
  FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON DELETE cascade,
  UNIQUE (`task_id`, `session_role`, `generation`)
);
--> statement-breakpoint
INSERT INTO `forge_herdr_role_sessions_new` SELECT * FROM `forge_herdr_role_sessions`;
--> statement-breakpoint
DROP TABLE `forge_herdr_role_sessions`;
--> statement-breakpoint
ALTER TABLE `forge_herdr_role_sessions_new` RENAME TO `forge_herdr_role_sessions`;
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_herdr_current_persistent_role_unique`
  ON `forge_herdr_role_sessions` (`task_id`, `session_role`)
  WHERE `is_current` = 1 AND `session_role` IN ('lead', 'developer');
--> statement-breakpoint
CREATE INDEX `forge_herdr_role_session_status_idx`
  ON `forge_herdr_role_sessions` (`status`, `updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forge_models` (
  `model_id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `description` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `forge_models` ADD COLUMN `provider` text NOT NULL DEFAULT 'codex';
--> statement-breakpoint
INSERT INTO `forge_models` (`model_id`, `display_name`, `description`, `status`, `sort_order`, `created_at`, `updated_at`, `provider`)
SELECT 'claude-fable-5', 'Claude Fable 5', 'Claude Code model', 'active', 10, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', 'claude'
WHERE NOT EXISTS (SELECT 1 FROM `forge_models` WHERE `model_id` = 'claude-fable-5');
--> statement-breakpoint
INSERT INTO `forge_models` (`model_id`, `display_name`, `description`, `status`, `sort_order`, `created_at`, `updated_at`, `provider`)
SELECT 'claude-opus-5', 'Claude Opus 5', 'Claude Code model', 'active', 20, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', 'claude'
WHERE NOT EXISTS (SELECT 1 FROM `forge_models` WHERE `model_id` = 'claude-opus-5');
--> statement-breakpoint
INSERT INTO `forge_models` (`model_id`, `display_name`, `description`, `status`, `sort_order`, `created_at`, `updated_at`, `provider`)
SELECT 'claude-sonnet-5', 'Claude Sonnet 5', 'Claude Code model', 'active', 30, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', 'claude'
WHERE NOT EXISTS (SELECT 1 FROM `forge_models` WHERE `model_id` = 'claude-sonnet-5');
--> statement-breakpoint
INSERT INTO `forge_models` (`model_id`, `display_name`, `description`, `status`, `sort_order`, `created_at`, `updated_at`, `provider`)
SELECT 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'Claude Code model', 'active', 40, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', 'claude'
WHERE NOT EXISTS (SELECT 1 FROM `forge_models` WHERE `model_id` = 'claude-haiku-4-5-20251001');
--> statement-breakpoint
INSERT INTO `forge_profiles` (`id`, `name`, `provider`, `model`, `reasoning_level`, `service_priority`, `capacity`, `created_at`, `updated_at`)
SELECT 'profile_default_claude_fable', 'Fable', 'claude', 'claude-fable-5', 'high', 'standard', 2, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM `forge_profiles` WHERE `id` = 'profile_default_claude_fable');
