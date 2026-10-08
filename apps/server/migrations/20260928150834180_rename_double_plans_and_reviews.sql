UPDATE suplex_workflows SET name = 'Double plans'
WHERE id = 'workflow_native_competing_plans' AND name = 'Extra plan'
  AND NOT EXISTS (SELECT 1 FROM suplex_workflows WHERE name = 'Double plans');
--> statement-breakpoint
UPDATE suplex_workflows SET name = 'Double reviews'
WHERE id = 'workflow_native_independent_review' AND name = 'Extra review'
  AND NOT EXISTS (SELECT 1 FROM suplex_workflows WHERE name = 'Double reviews');
