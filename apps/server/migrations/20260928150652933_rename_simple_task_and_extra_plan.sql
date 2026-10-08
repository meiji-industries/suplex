UPDATE suplex_workflows SET name = 'Simple task'
WHERE id = 'workflow_native_direct_build' AND name = 'Just build'
  AND NOT EXISTS (SELECT 1 FROM suplex_workflows WHERE name = 'Simple task');
--> statement-breakpoint
UPDATE suplex_workflows SET name = 'Extra plan'
WHERE id = 'workflow_native_competing_plans' AND name = 'Combined planning'
  AND NOT EXISTS (SELECT 1 FROM suplex_workflows WHERE name = 'Extra plan');
