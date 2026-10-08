UPDATE suplex_workflows SET name = 'Review and repair'
WHERE id = 'workflow_native_refine_pull_request' AND name = 'Pull request repair'
  AND NOT EXISTS (SELECT 1 FROM suplex_workflows WHERE name = 'Review and repair');
