-- One avatar record per owner: a user, company, project, or agent id.
CREATE TABLE `suplex_avatars` (
  `owner_id` text PRIMARY KEY NOT NULL,
  `shape` text CHECK (`shape` IN ('square', 'circle')),
  `mime_type` text,
  `image` blob,
  `updated_at` text NOT NULL,
  CONSTRAINT `suplex_avatars_image_shape_check` CHECK ((`mime_type` IS NULL) = (`image` IS NULL))
);
