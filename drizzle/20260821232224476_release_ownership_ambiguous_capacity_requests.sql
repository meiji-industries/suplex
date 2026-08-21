UPDATE forge_capacity_requests
SET status = 'released',
    terminal_reason = COALESCE(terminal_reason, 'process_failed'),
    released_at = COALESCE(released_at, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'ownership_ambiguous';
