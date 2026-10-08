ALTER TABLE suplex_task_controls ADD COLUMN workflow text NOT NULL DEFAULT 'standard';
--> statement-breakpoint
ALTER TABLE suplex_task_controls ADD COLUMN advisor_profiles_json text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE suplex_task_controls ADD COLUMN workflow_state_json text NOT NULL DEFAULT '{"version":1,"reviews":[],"acceptedDelivery":null,"deliveryWait":null,"completion":null,"toolOwner":null}';
--> statement-breakpoint
ALTER TABLE suplex_task_sessions ADD COLUMN advisor_role text;
--> statement-breakpoint
ALTER TABLE suplex_task_sessions ADD COLUMN workflow_input_json text;
