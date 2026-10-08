CREATE TABLE suplex_company_billing (
  company_id TEXT PRIMARY KEY REFERENCES suplex_companies(id) ON DELETE RESTRICT,
  registration_id TEXT NOT NULL UNIQUE,
  credential TEXT NOT NULL,
  account_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
