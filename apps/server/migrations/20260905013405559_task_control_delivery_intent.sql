-- Write migration SQL here.
ALTER TABLE suplex_task_controls ADD COLUMN delivery_intent_json text;
--> statement-breakpoint
ALTER TABLE suplex_task_controls ADD COLUMN reviewed_head_json text;
--> statement-breakpoint
DELETE FROM suplex_task_controls;
