-- Write migration SQL here.
-- Phase 1's provider-cutover migration already dropped the lease table and
-- rebuilt result claims directly on forge_developer_executions. Retain this
-- timestamped migration as the explicit Phase 3e cutover checkpoint.
SELECT 1;
