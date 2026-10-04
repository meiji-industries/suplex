-- The last plan suplex.sh confirmed for the linked Suplex account. Pro access
-- holds while access_until is in the future and the same account is linked.
CREATE TABLE suplex_plan (
  id TEXT PRIMARY KEY CHECK (id = 'host'),
  account_id TEXT NOT NULL,
  access_until TEXT,
  checked_at TEXT NOT NULL
);
