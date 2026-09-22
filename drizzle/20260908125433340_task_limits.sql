ALTER TABLE suplex_environment_settings ADD COLUMN default_budget_usd REAL NOT NULL DEFAULT 15 CHECK (default_budget_usd >= 0);
--> statement-breakpoint
ALTER TABLE suplex_environment_settings ADD COLUMN default_max_turns INTEGER NOT NULL DEFAULT 40 CHECK (default_max_turns >= 0);
--> statement-breakpoint
ALTER TABLE suplex_task_controls ADD COLUMN budget_usd REAL;
--> statement-breakpoint
ALTER TABLE suplex_task_controls ADD COLUMN max_turns INTEGER;
