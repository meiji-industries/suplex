CREATE TABLE suplex_local_endpoints (
  id text PRIMARY KEY NOT NULL,
  label text NOT NULL,
  base_url text NOT NULL,
  api_key text,
  model_id text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
