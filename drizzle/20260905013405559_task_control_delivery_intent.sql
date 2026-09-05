-- Write migration SQL here.
ALTER TABLE forge_task_controls ADD COLUMN delivery_intent_json text;
--> statement-breakpoint
ALTER TABLE forge_task_controls ADD COLUMN reviewed_head_json text;
--> statement-breakpoint
DELETE FROM forge_task_controls;
