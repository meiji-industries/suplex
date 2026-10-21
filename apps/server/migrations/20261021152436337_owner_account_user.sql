-- The linked account signs in as user_development. Hosts linked before
-- accounts::link recorded that mapping get it here, unless another user
-- already holds the account or its email.
INSERT OR IGNORE INTO suplex_account_users (user_id, account_id, email)
SELECT 'user_development', account_id, email FROM suplex_account
WHERE id = 'host' AND EXISTS (SELECT 1 FROM suplex_users WHERE id = 'user_development');
