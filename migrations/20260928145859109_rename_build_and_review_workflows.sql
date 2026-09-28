UPDATE suplex_workflows SET name = 'Just build'
WHERE id = 'workflow_native_direct_build' AND name = 'Direct build'
  AND NOT EXISTS (SELECT 1 FROM suplex_workflows WHERE name = 'Just build');
--> statement-breakpoint
UPDATE suplex_workflows SET name = 'Extra review'
WHERE id = 'workflow_native_independent_review' AND name = 'Second opinion'
  AND NOT EXISTS (SELECT 1 FROM suplex_workflows WHERE name = 'Extra review');
