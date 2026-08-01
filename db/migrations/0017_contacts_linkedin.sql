-- Contacts: add a structured LinkedIn URL field so the digest's
-- "mark as interesting" action can persist a profile link cleanly
-- instead of stuffing it into notes.

ALTER TABLE contacts ADD COLUMN linkedin_url TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_linkedin ON contacts(linkedin_url);
