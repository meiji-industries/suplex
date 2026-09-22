ALTER TABLE suplex_task_controls ADD COLUMN recovery_turn_id TEXT REFERENCES suplex_task_turns(id);
