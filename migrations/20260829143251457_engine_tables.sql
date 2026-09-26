CREATE TABLE suplex_engine_activities (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL,
  activity TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE INDEX suplex_engine_activities_workflow_idx ON suplex_engine_activities(workflow_id);

CREATE TABLE suplex_engine_commands (
  command_id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL,
  command TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX suplex_engine_commands_workflow_idx ON suplex_engine_commands(workflow_id);
