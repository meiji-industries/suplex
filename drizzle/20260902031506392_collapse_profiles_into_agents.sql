INSERT INTO suplex_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at)
SELECT p.id || '-' || a.id, a.name || ' settings', p.provider, p.model, p.reasoning_level, p.service_priority, p.capacity, p.created_at, p.updated_at
FROM suplex_agents a
JOIN suplex_profiles p ON p.id = a.profile_id
WHERE a.kind = 'internal'
  AND a.id != (
    SELECT MIN(first_agent.id)
    FROM suplex_agents first_agent
    WHERE first_agent.kind = 'internal' AND first_agent.profile_id = a.profile_id
  );
--> statement-breakpoint
UPDATE suplex_agents
SET profile_id = profile_id || '-' || id
WHERE kind = 'internal'
  AND id != (
    SELECT MIN(first_agent.id)
    FROM suplex_agents first_agent
    WHERE first_agent.kind = 'internal' AND first_agent.profile_id = suplex_agents.profile_id
  );
--> statement-breakpoint
UPDATE suplex_profiles
SET name = '__suplex_agent_profile_' || id
WHERE id IN (SELECT profile_id FROM suplex_agents WHERE kind = 'internal');
--> statement-breakpoint
UPDATE suplex_profiles
SET name = (
  SELECT a.name || CASE
    WHEN EXISTS (SELECT 1 FROM suplex_profiles other WHERE other.name = a.name AND other.id != suplex_profiles.id)
      THEN ' (' || a.id || ')'
    ELSE ''
  END
  FROM suplex_agents a
  WHERE a.kind = 'internal' AND a.profile_id = suplex_profiles.id
)
WHERE id IN (SELECT profile_id FROM suplex_agents WHERE kind = 'internal');
