-- Hosted billing service tables. Applied at service startup; these are not
-- Suplex app migrations and never live in an installation database.
CREATE TABLE IF NOT EXISTS billing_accounts (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE,
  credential_hash TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  revenuecat_app_user_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  subscription_hint TEXT,
  revenuecat_fingerprint TEXT,
  next_sync_at TEXT,
  sync_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (sync_attempt_count >= 0),
  last_sync_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_operations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('checkout', 'seat_preview', 'seat_change')),
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'provider_pending', 'completed', 'failed')),
  provider_data_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS billing_events (
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'revenuecat')),
  event_id TEXT NOT NULL,
  account_id TEXT REFERENCES billing_accounts(id) ON DELETE SET NULL,
  object_id TEXT,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY(provider, event_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_accounts_credential_hash_unique ON billing_accounts (credential_hash);
CREATE UNIQUE INDEX IF NOT EXISTS billing_operations_pending_mutation_unique ON billing_operations (account_id) WHERE kind IN ('checkout', 'seat_change') AND state IN ('prepared', 'provider_pending');
CREATE INDEX IF NOT EXISTS billing_operations_account_state ON billing_operations (account_id, state);
CREATE INDEX IF NOT EXISTS billing_events_pending_due ON billing_events (next_attempt_at) WHERE processed_at IS NULL;
