UPDATE suplex_workflows SET name = 'Plan and build'
WHERE id = 'workflow_native_standard' AND name = 'Standard'
  AND NOT EXISTS (SELECT 1 FROM suplex_workflows WHERE name = 'Plan and build');
