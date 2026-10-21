CREATE INDEX `suplex_audit_events_task_idx` ON `suplex_audit_events` (json_extract(`metadata_json`, '$.taskId'));
