-- Write migration SQL here.
ALTER TABLE suplex_projects ADD COLUMN agent_task_policy_json text NOT NULL DEFAULT '{}';
--> statement-breakpoint
UPDATE suplex_projects
SET agent_task_policy_json = json_object(
  'workflowIds', json_array('workflow_native_standard'),
  'templateIds', json_array(),
  'rootProfileIds', json_array(root_profile_id),
  'workerProfileIds', json_array(worker_profile_id),
  'advisorProfileIds', json_object(),
  'deliveryTarget', 'pull_request_draft',
  'runProjectTests', 1,
  'visualEvidence', 'off'
);
