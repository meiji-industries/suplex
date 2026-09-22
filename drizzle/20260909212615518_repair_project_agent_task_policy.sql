-- Write migration SQL here.
UPDATE suplex_projects
SET agent_task_policy_json = json_set(
  CASE WHEN agent_task_policy_json = '{}' THEN json_object(
    'workflowIds', json_array('workflow_native_standard'),
    'templateIds', json_array(),
    'rootProfileIds', json_array(root_profile_id),
    'workerProfileIds', json_array(worker_profile_id),
    'advisorProfileIds', json_object(),
    'deliveryTarget', 'pull_request_draft',
    'runProjectTests', json('true'),
    'visualEvidence', 'off'
  ) ELSE agent_task_policy_json END,
  '$.defaultWorkflowId', COALESCE(json_extract(agent_task_policy_json, '$.defaultWorkflowId'), json_extract(agent_task_policy_json, '$.workflowIds[0]'), 'workflow_native_standard'),
  '$.runProjectTests', CASE WHEN json_type(agent_task_policy_json, '$.runProjectTests') = 'false' THEN json('false') ELSE json('true') END
);
