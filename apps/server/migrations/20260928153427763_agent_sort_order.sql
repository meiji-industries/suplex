ALTER TABLE suplex_profiles ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 1000;
--> statement-breakpoint
UPDATE suplex_profiles SET sort_order = CASE id
  WHEN 'profile_native_root' THEN 10
  WHEN 'profile_native_independent' THEN 20
  WHEN 'profile_native_worker' THEN 30
END
WHERE id IN ('profile_native_root', 'profile_native_independent', 'profile_native_worker');
