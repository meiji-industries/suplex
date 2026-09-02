INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at)
SELECT p.id || '-' || a.id, a.name || ' settings', p.provider, p.model, p.reasoning_level, p.service_priority, p.capacity, p.created_at, p.updated_at
FROM forge_agents a
JOIN forge_profiles p ON p.id = a.profile_id
WHERE a.kind = 'internal'
  AND a.id != (
    SELECT MIN(first_agent.id)
    FROM forge_agents first_agent
    WHERE first_agent.kind = 'internal' AND first_agent.profile_id = a.profile_id
  );
--> statement-breakpoint
UPDATE forge_agents
SET profile_id = profile_id || '-' || id
WHERE kind = 'internal'
  AND id != (
    SELECT MIN(first_agent.id)
    FROM forge_agents first_agent
    WHERE first_agent.kind = 'internal' AND first_agent.profile_id = forge_agents.profile_id
  );
--> statement-breakpoint
UPDATE forge_profiles
SET name = '__forge_agent_profile_' || id
WHERE id IN (SELECT profile_id FROM forge_agents WHERE kind = 'internal');
--> statement-breakpoint
UPDATE forge_profiles
SET name = (
  SELECT a.name || CASE
    WHEN EXISTS (SELECT 1 FROM forge_profiles other WHERE other.name = a.name AND other.id != forge_profiles.id)
      THEN ' (' || a.id || ')'
    ELSE ''
  END
  FROM forge_agents a
  WHERE a.kind = 'internal' AND a.profile_id = forge_profiles.id
)
WHERE id IN (SELECT profile_id FROM forge_agents WHERE kind = 'internal');
