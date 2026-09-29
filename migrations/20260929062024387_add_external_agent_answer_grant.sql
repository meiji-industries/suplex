ALTER TABLE `suplex_external_agents` ADD `answer_granted_by_user_id` text REFERENCES `suplex_users`(`id`);
--> statement-breakpoint
ALTER TABLE `suplex_external_agents` ADD `answer_granted_at` text;
