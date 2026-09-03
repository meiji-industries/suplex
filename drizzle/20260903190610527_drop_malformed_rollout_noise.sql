DELETE FROM forge_issue_timeline
WHERE source = 'agent'
  AND metadata_json LIKE '%"text":"Malformed Codex rollout line"%';
