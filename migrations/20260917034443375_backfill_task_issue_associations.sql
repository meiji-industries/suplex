UPDATE suplex_tasks
SET issue_json = json_object(
  'kind', 'github',
  'repository', json_extract(configuration_json, '$.repository'),
  'number', json_extract(configuration_json, '$.source.number'),
  'id', CAST(json_extract(configuration_json, '$.source.number') AS TEXT),
  'key', '#' || json_extract(configuration_json, '$.source.number'),
  'title', title,
  'url', 'https://github.com/' || json_extract(configuration_json, '$.repository') || '/issues/' || json_extract(configuration_json, '$.source.number')
)
WHERE issue_json IS NULL
  AND json_extract(configuration_json, '$.source.kind') = 'issue'
  AND json_extract(configuration_json, '$.source.number') > 0
  AND json_extract(configuration_json, '$.repository') IS NOT NULL;
