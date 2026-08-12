ALTER TABLE `forge_project_revisions` ADD COLUMN `state` text NOT NULL DEFAULT 'accepted';
--> statement-breakpoint
UPDATE `forge_project_revisions`
SET `state` = CASE
  WHEN `base_sha` IS NULL OR `target_sha` IS NULL THEN 'draft'
  ELSE 'accepted'
END;
--> statement-breakpoint
UPDATE `forge_projects`
SET `status` = 'needs-reactivation'
WHERE `status` = 'active'
  AND `active_revision_id` IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM `forge_project_revisions` r
    WHERE r.`id` = `forge_projects`.`active_revision_id`
      AND (r.`base_sha` IS NULL OR r.`target_sha` IS NULL)
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `forge_project_revisions_project_state_idx`
  ON `forge_project_revisions` (`project_id`, `state`, `revision`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `forge_project_revisions_accepted_sha_insert`
BEFORE INSERT ON `forge_project_revisions`
WHEN NEW.`state` = 'accepted' AND (NEW.`base_sha` IS NULL OR NEW.`target_sha` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'accepted project revisions require exact base and target SHAs');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `forge_project_revisions_accepted_sha_update`
BEFORE UPDATE OF `state`, `base_sha`, `target_sha` ON `forge_project_revisions`
WHEN NEW.`state` = 'accepted' AND (NEW.`base_sha` IS NULL OR NEW.`target_sha` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'accepted project revisions require exact base and target SHAs');
END;
