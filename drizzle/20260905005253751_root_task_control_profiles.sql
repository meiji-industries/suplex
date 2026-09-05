ALTER TABLE forge_task_controls ADD COLUMN root_profile_json text NOT NULL DEFAULT '{"profileId":"unconfigured","provider":"codex","model":"unconfigured","reasoningLevel":"medium","serviceTier":"default"}';
--> statement-breakpoint
ALTER TABLE forge_task_controls ADD COLUMN worker_profile_json text NOT NULL DEFAULT '{"profileId":"unconfigured","provider":"codex","model":"unconfigured","reasoningLevel":"medium","serviceTier":"default"}';
