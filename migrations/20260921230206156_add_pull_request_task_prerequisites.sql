CREATE TABLE suplex_task_pull_request_dependencies (
  task_id TEXT NOT NULL REFERENCES suplex_tasks(id) ON DELETE CASCADE,
  pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (task_id, pull_request_number)
);
