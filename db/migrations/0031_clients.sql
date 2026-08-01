-- 0031 — clients (companies) table: the CRM layer above contacts.
--
-- `contacts` (0010) is people. A real CRM needs the company those people
-- belong to as a first-class record, so an "account" can hold many contacts
-- and carry its own status (are we actively engaged?) and engagement notes.
--
-- A contact links to a client via contacts.client_id (nullable — a contact can
-- exist without a company, e.g. an individual prospect). The free-text
-- contacts.company column is kept for display / unlinked rows and is treated
-- as a fallback when client_id is null.
--
-- Taxonomy (canonical — mirror in knowledge doc nyyon-crm-taxonomy):
--   status : active | past | prospect | partner
--   tags   : JSON array of free-form labels ("saas","fintech","il","ppc")
--
-- No seed rows. An empty clients table IS the truth on a fresh install;
-- the operator (or Nyo) populates real accounts.

CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | past | prospect | partner
  industry    TEXT,
  website     TEXT,
  engagement  TEXT,                            -- what Nyyon does for them (PPC, website, SEO, deck, content…)
  owner       TEXT,
  tags        TEXT,                            -- JSON array, nullable
  notes       TEXT,                            -- markdown
  starred     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT,
  updated_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_clients_status     ON clients(status);
CREATE INDEX IF NOT EXISTS idx_clients_starred    ON clients(starred);
CREATE INDEX IF NOT EXISTS idx_clients_updated_at ON clients(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_clients_name       ON clients(name);

-- Link contacts → clients. Nullable so a contact can be unaffiliated.
ALTER TABLE contacts ADD COLUMN client_id TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_client ON contacts(client_id);
