-- 0010 — contacts table.
-- Operator-curated layer ON TOP of `identities`. An identity is auto-created
-- whenever any human touches the funnel (web cookie ID'd by email, WA inbound
-- phone, etc.) — most identities will NOT become contacts. A contact is an
-- explicit "I care about this person" decision by the operator.
--
-- Taxonomy (canonical — also lives in knowledge doc nyyon-contacts-taxonomy):
--   status  : prospect | lead | client | past_client | partner | do_not_contact
--   source  : referral | inbound_form | inbound_wa | inbound_email | paid_ad
--           | event | cold_outreach | social | other
--   tags    : JSON array of free-form labels (e.g. "saas", "fintech", "il-tlv")
--   owner   : free-form (operator handle / email) — UI suggests existing owners

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  identity_id TEXT,              -- FK to identities.id; nullable so operator can curate before/without an identity
  full_name TEXT,
  email TEXT,
  phone TEXT,
  company TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'prospect',
  source TEXT,
  owner TEXT,
  tags TEXT,                      -- JSON array, nullable
  notes TEXT,                     -- markdown
  starred INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_status      ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_owner       ON contacts(owner);
CREATE INDEX IF NOT EXISTS idx_contacts_source      ON contacts(source);
CREATE INDEX IF NOT EXISTS idx_contacts_starred     ON contacts(starred);
CREATE INDEX IF NOT EXISTS idx_contacts_email       ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_phone       ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_identity    ON contacts(identity_id);
CREATE INDEX IF NOT EXISTS idx_contacts_updated_at  ON contacts(updated_at DESC);

-- Seed rows removed 2026-06-01.
--
-- The original migration inserted 5 fake contacts (Michal Hasson, Sarah
-- Patel, Daniel Cohen, Maya Levin, Eitan Goldstein) as placeholder UI fodder.
-- Same problem as the digest seed: the rows looked real, paired up with
-- equally fake digest items, and let Nyo refer to non-existent people as
-- if they actually existed in the operator's pipeline.
--
-- DO NOT reintroduce seed contacts. An empty contacts table IS the truth
-- on a fresh install; the WA promote / digest wishlist flows populate
-- real rows.
