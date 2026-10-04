-- A remote login started from a recovery link links the account as this host's owner when it completes.
ALTER TABLE suplex_account_login_attempts ADD COLUMN recovery_invitation_id TEXT;
