ALTER TABLE forge_task_controls ADD COLUMN recovery_turn_id TEXT REFERENCES forge_task_turns(id);
