-- Write migration SQL here.
CREATE TABLE forge_provider_instances (
  id text PRIMARY KEY NOT NULL,
  provider text NOT NULL,
  label text NOT NULL,
  home_directory text NOT NULL UNIQUE,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
--> statement-breakpoint
ALTER TABLE forge_profiles ADD COLUMN provider_instance_id text REFERENCES forge_provider_instances(id);
