-- A display snapshot of the last hosted billing read. It labels the company; no decision reads it.
ALTER TABLE suplex_company_billing ADD COLUMN plan TEXT CHECK (plan IN ('free', 'pro'));
--> statement-breakpoint
ALTER TABLE suplex_company_billing ADD COLUMN access_until TEXT;
--> statement-breakpoint
ALTER TABLE suplex_company_billing ADD COLUMN checked_at TEXT;
