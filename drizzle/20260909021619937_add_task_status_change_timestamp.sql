-- Write migration SQL here.
ALTER TABLE forge_task_controls ADD COLUMN status_changed_at TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE forge_task_controls SET status_changed_at = COALESCE(NULLIF(updated_at, ''), created_at);
--> statement-breakpoint
CREATE TRIGGER forge_task_controls_status_changed_at
AFTER UPDATE OF status ON forge_task_controls
WHEN NEW.status IS NOT OLD.status
BEGIN
  UPDATE forge_task_controls SET status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE task_id = NEW.task_id;
END;
