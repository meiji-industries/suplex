ALTER TABLE suplex_task_turns ADD COLUMN dispatch_attempt_json text
  CHECK (dispatch_attempt_json IS NULL OR json_valid(dispatch_attempt_json));
