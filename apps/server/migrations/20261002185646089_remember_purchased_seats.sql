-- The purchased seats of the last hosted billing read. With the snapshot's
-- plan and access_until, it keeps confirmed Pro usable through a hosted
-- outage until the paid period ends; it never extends or grants Pro.
ALTER TABLE suplex_company_billing ADD COLUMN purchased_seats INTEGER;
