-- The paid plan of the last confirmed subscription: 'pro' or 'team'. It stays
-- after paid access ends, so a lapsed Team plan can be told from Free.
ALTER TABLE suplex_plan ADD COLUMN plan TEXT;
