-- Hosted Suplex accounts, in the billing database. Only hashes of magic-link
-- and account tokens are stored.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_attempts (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  provider TEXT CHECK (provider IN ('google', 'github', 'email')),
  provider_state TEXT UNIQUE,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT 'desktop' CHECK (client IN ('desktop', 'web'))
);

CREATE TABLE IF NOT EXISTS account_magic_links (
  token_hash TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES account_attempts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS account_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS account_attempts_expires ON account_attempts (expires_at);
CREATE INDEX IF NOT EXISTS account_magic_links_email_created ON account_magic_links (email, created_at);

CREATE TABLE IF NOT EXISTS company_invitations (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  company_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  host_origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  sent_at TEXT,
  accepted_account_id TEXT REFERENCES accounts(id)
);

-- Each choice about product update emails, oldest first. The latest row for
-- an account is its current choice; every row keeps the wording the person saw.
-- `email` rows come from the unsubscribe link in an email, through Resend.
CREATE TABLE IF NOT EXISTS account_email_updates (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subscribed INTEGER NOT NULL CHECK (subscribed IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('onboarding', 'settings', 'email')),
  wording TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS account_email_updates_account ON account_email_updates (account_id, id);

-- Resend contact changes to send, oldest first. Rows are keyed by email with
-- no account reference, so a contact deletion outlives its account. The
-- latest sent contact change per email stays; sent events are deleted.
CREATE TABLE IF NOT EXISTS account_resend_outbox (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('contact', 'event', 'delete')),
  unsubscribed INTEGER CHECK (unsubscribed IN (0, 1)),
  first_name TEXT,
  event TEXT,
  payload_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS account_resend_outbox_email ON account_resend_outbox (email, id);
CREATE INDEX IF NOT EXISTS account_resend_outbox_pending ON account_resend_outbox (id) WHERE sent_at IS NULL;
