-- Write migration SQL here.
CREATE TABLE `forge_task_template_seeds` (
  `project_id` text NOT NULL,
  `template_name` text NOT NULL,
  `seeded_at` text NOT NULL,
  PRIMARY KEY (`project_id`, `template_name`)
);
