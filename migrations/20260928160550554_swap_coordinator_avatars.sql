UPDATE suplex_profiles
SET avatar_seed = CASE id
  WHEN 'profile_native_root' THEN '00000000000000000000000000000003'
  WHEN 'profile_native_independent' THEN '00000000000000000000000000000001'
END
WHERE (id = 'profile_native_root' AND avatar_seed = '00000000000000000000000000000001')
   OR (id = 'profile_native_independent' AND avatar_seed = '00000000000000000000000000000003');
