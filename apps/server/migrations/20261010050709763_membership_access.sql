-- What a member can do in a company: 'edit' changes work, 'read' only views it.
ALTER TABLE suplex_memberships ADD COLUMN access TEXT NOT NULL DEFAULT 'edit';
