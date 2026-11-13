-- The company feed reads this revision on each commit to find out whether
-- the stored usage behind task costs changed. Each trigger counts one change
-- to a value the costs read.
CREATE TABLE `suplex_company_usage_revisions` (
  `company_id` text PRIMARY KEY NOT NULL,
  `revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `suplex_task_usage_revision_insert`
AFTER INSERT ON `suplex_task_usage`
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = NEW.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_task_usage_revision_update`
AFTER UPDATE ON `suplex_task_usage`
WHEN `OLD`.`snapshot` IS NOT `NEW`.`snapshot` OR `OLD`.`task_id` IS NOT `NEW`.`task_id`
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = NEW.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = OLD.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_task_usage_revision_delete`
AFTER DELETE ON `suplex_task_usage`
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = OLD.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_task_analytics_sessions_revision_insert`
AFTER INSERT ON `suplex_task_analytics_sessions`
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = NEW.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_task_analytics_sessions_revision_update`
AFTER UPDATE ON `suplex_task_analytics_sessions`
WHEN (`OLD`.`observed_at` IS NULL) IS NOT (`NEW`.`observed_at` IS NULL) OR (`OLD`.`error_at` IS NULL) IS NOT (`NEW`.`error_at` IS NULL) OR `OLD`.`task_id` IS NOT `NEW`.`task_id`
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = NEW.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = OLD.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_task_analytics_sessions_revision_delete`
AFTER DELETE ON `suplex_task_analytics_sessions`
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = OLD.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_task_sessions_revision_insert`
AFTER INSERT ON `suplex_task_sessions`
WHEN `NEW`.`native_session_id` IS NOT NULL
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = NEW.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_task_sessions_revision_update`
AFTER UPDATE ON `suplex_task_sessions`
WHEN `OLD`.`native_session_id` IS NOT `NEW`.`native_session_id` OR `OLD`.`task_id` IS NOT `NEW`.`task_id`
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = NEW.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = OLD.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_task_sessions_revision_delete`
AFTER DELETE ON `suplex_task_sessions`
WHEN `OLD`.`native_session_id` IS NOT NULL
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  SELECT `company_id`, 1 FROM `suplex_tasks` WHERE `id` = OLD.`task_id`
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_tasks_revision_insert`
AFTER INSERT ON `suplex_tasks`
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  VALUES (NEW.`company_id`, 1)
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_tasks_revision_update`
AFTER UPDATE OF `company_id` ON `suplex_tasks`
WHEN `OLD`.`company_id` IS NOT `NEW`.`company_id`
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  VALUES (NEW.`company_id`, 1)
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  VALUES (OLD.`company_id`, 1)
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `suplex_tasks_revision_delete`
AFTER DELETE ON `suplex_tasks`
BEGIN
  INSERT INTO `suplex_company_usage_revisions` (`company_id`, `revision`)
  VALUES (OLD.`company_id`, 1)
  ON CONFLICT(`company_id`) DO UPDATE SET `revision` = `revision` + 1;
END;
