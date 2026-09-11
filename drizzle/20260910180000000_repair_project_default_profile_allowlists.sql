-- Write migration SQL here.
UPDATE forge_projects
SET agent_task_policy_json = json_set(
  agent_task_policy_json,
  '$.rootProfileIds[#]', root_profile_id
)
WHERE json_type(agent_task_policy_json, '$.rootProfileIds') = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(agent_task_policy_json, '$.rootProfileIds') WHERE value = root_profile_id);

UPDATE forge_projects
SET agent_task_policy_json = json_set(
  agent_task_policy_json,
  '$.workerProfileIds[#]', worker_profile_id
)
WHERE json_type(agent_task_policy_json, '$.workerProfileIds') = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(agent_task_policy_json, '$.workerProfileIds') WHERE value = worker_profile_id);
