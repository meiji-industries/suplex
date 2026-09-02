UPDATE forge_issue_projections
SET step = phase
WHERE step IS NULL
  AND phase IN (
    'backlog',
    'planning', 'supplemental_review', 'plan_consolidation',
    'approval',
    'ready_for_development', 'development', 'repair_required',
    'delivery_ready', 'reviewing_delivery', 'delivery_reviewed', 'final_review',
    'releasing', 'merge_conflict_reviewing', 'merge_conflict_resolving',
    'ci_waiting', 'ci_repair_planning', 'ci_repairing',
    'accepted', 'ready_reconciliation', 'manual_merge',
    'done', 'cancelled'
  );

--> statement-breakpoint

UPDATE forge_issue_projections
SET phase = CASE step
  WHEN 'backlog' THEN 'backlog'
  WHEN 'planning' THEN 'planning'
  WHEN 'supplemental_review' THEN 'planning'
  WHEN 'plan_consolidation' THEN 'planning'
  WHEN 'approval' THEN 'approval'
  WHEN 'ready_for_development' THEN 'building'
  WHEN 'development' THEN 'building'
  WHEN 'repair_required' THEN 'building'
  WHEN 'delivery_ready' THEN 'reviewing'
  WHEN 'reviewing_delivery' THEN 'reviewing'
  WHEN 'delivery_reviewed' THEN 'reviewing'
  WHEN 'final_review' THEN 'reviewing'
  WHEN 'releasing' THEN 'shipping'
  WHEN 'merge_conflict_reviewing' THEN 'shipping'
  WHEN 'merge_conflict_resolving' THEN 'shipping'
  WHEN 'ci_waiting' THEN 'shipping'
  WHEN 'ci_repair_planning' THEN 'shipping'
  WHEN 'ci_repairing' THEN 'shipping'
  WHEN 'accepted' THEN 'shipping'
  WHEN 'ready_reconciliation' THEN 'shipping'
  WHEN 'manual_merge' THEN 'shipping'
  WHEN 'done' THEN 'done'
  WHEN 'cancelled' THEN 'cancelled'
END
WHERE phase IN (
  'backlog',
  'planning', 'supplemental_review', 'plan_consolidation',
  'approval',
  'ready_for_development', 'development', 'repair_required',
  'delivery_ready', 'reviewing_delivery', 'delivery_reviewed', 'final_review',
  'releasing', 'merge_conflict_reviewing', 'merge_conflict_resolving',
  'ci_waiting', 'ci_repair_planning', 'ci_repairing',
  'accepted', 'ready_reconciliation', 'manual_merge',
  'done', 'cancelled'
  );
