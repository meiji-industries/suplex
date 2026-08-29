CREATE TABLE `forge_herdr_role_sessions_new` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `session_role` text NOT NULL CHECK (`session_role` IN ('planner', 'builder', 'reviewer', 'integrator')),
  `generation` integer NOT NULL CHECK (`generation` >= 0),
  `is_current` integer NOT NULL DEFAULT 1 CHECK (`is_current` IN (0, 1)),
  `provider_kind` text NOT NULL CHECK (`provider_kind` IN ('codex', 'claude', 'openrouter')),
  `codex_session_id` text UNIQUE, `agent_name` text, `pane_id` text, `rollout_path` text,
  `launch_fingerprint` text, `guard_directory` text,
  `status` text NOT NULL CHECK (`status` IN ('unbound', 'starting', 'ready', 'working', 'blocked', 'missing', 'closed', 'failed')),
  `last_agent_status` text, `attention_activated_at` text, `ensure_token` text, `ensure_expires_at` text,
  `created_at` text NOT NULL, `updated_at` text NOT NULL, `last_seen_at` text, `attention_excerpt` text,
  FOREIGN KEY (`task_id`) REFERENCES `forge_tasks`(`id`) ON DELETE cascade,
  UNIQUE (`task_id`, `session_role`, `generation`)
);
--> statement-breakpoint
INSERT INTO `forge_herdr_role_sessions_new` (`id`, `task_id`, `session_role`, `generation`, `is_current`, `provider_kind`, `codex_session_id`, `agent_name`, `pane_id`, `rollout_path`, `launch_fingerprint`, `guard_directory`, `status`, `last_agent_status`, `attention_activated_at`, `ensure_token`, `ensure_expires_at`, `created_at`, `updated_at`, `last_seen_at`, `attention_excerpt`)
SELECT `id`, `task_id`, CASE `session_role` WHEN 'lead' THEN 'planner' WHEN 'developer' THEN 'builder' ELSE `session_role` END, `generation`, `is_current`, `provider_kind`, `codex_session_id`, `agent_name`, `pane_id`, `rollout_path`, `launch_fingerprint`, `guard_directory`, `status`, `last_agent_status`, `attention_activated_at`, `ensure_token`, `ensure_expires_at`, `created_at`, `updated_at`, `last_seen_at`, `attention_excerpt`
FROM `forge_herdr_role_sessions`;
--> statement-breakpoint
DROP TABLE `forge_herdr_role_sessions`;
--> statement-breakpoint
ALTER TABLE `forge_herdr_role_sessions_new` RENAME TO `forge_herdr_role_sessions`;
--> statement-breakpoint
UPDATE `forge_herdr_role_sessions` SET `is_current` = 0
WHERE `session_role` = 'reviewer' AND `is_current` = 1
  AND `generation` < (SELECT MAX(`newer`.`generation`) FROM `forge_herdr_role_sessions` `newer` WHERE `newer`.`task_id` = `forge_herdr_role_sessions`.`task_id` AND `newer`.`session_role` = 'reviewer' AND `newer`.`is_current` = 1);
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_herdr_current_persistent_role_unique` ON `forge_herdr_role_sessions` (`task_id`, `session_role`) WHERE `is_current` = 1;
--> statement-breakpoint
CREATE INDEX `forge_herdr_role_session_status_idx` ON `forge_herdr_role_sessions` (`status`, `updated_at`);
