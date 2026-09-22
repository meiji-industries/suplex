ALTER TABLE suplex_task_sessions ADD COLUMN launch_owner text;
--> statement-breakpoint
ALTER TABLE suplex_task_sessions ADD COLUMN launch_claimed_at text;
--> statement-breakpoint
ALTER TABLE suplex_task_turns ADD COLUMN native_turn_id text;
--> statement-breakpoint
ALTER TABLE suplex_task_turns ADD COLUMN prompt_observed_at text;
