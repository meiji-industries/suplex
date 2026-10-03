CREATE TABLE suplex_account_users (
  user_id TEXT PRIMARY KEY REFERENCES suplex_users(id),
  account_id TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE
);
--> statement-breakpoint
CREATE TABLE suplex_company_invitations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES suplex_companies(id),
  user_id TEXT NOT NULL REFERENCES suplex_users(id),
  email TEXT NOT NULL COLLATE NOCASE,
  full_name TEXT NOT NULL,
  host_origin TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  sent_at TEXT,
  accepted_at TEXT,
  revoked_at TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX suplex_company_invitation_pending ON suplex_company_invitations(company_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
--> statement-breakpoint
CREATE TABLE suplex_account_sessions (
  token_hash TEXT PRIMARY KEY REFERENCES suplex_sessions(token_hash) ON DELETE CASCADE,
  account_id TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE suplex_account_login_attempts (
  id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  local_owner INTEGER NOT NULL CHECK(local_owner IN (0, 1)),
  expires_at TEXT NOT NULL
);
