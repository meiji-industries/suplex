ALTER TABLE suplex_task_controls ADD COLUMN dispatch_notice_json text;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `suplex_task_controls_dispatch_notice_status`
AFTER UPDATE OF `status` ON `suplex_task_controls`
WHEN `NEW`.`status` IS NOT `OLD`.`status` AND `NEW`.`dispatch_notice_json` IS NOT NULL
BEGIN
  UPDATE `suplex_task_controls` SET `dispatch_notice_json` = NULL WHERE `task_id` = `NEW`.`task_id`;
END;
