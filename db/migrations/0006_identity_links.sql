-- 0006 — identity_links audit table. Every (cookie ↔ person ↔ identifier) tuple
-- gets a row, so we can answer "how was this person identified, when, from where"
-- and surface cross-device cookies on the identity detail view.

CREATE TABLE IF NOT EXISTS identity_links (
  id TEXT PRIMARY KEY,
  cookie_id        TEXT,
  person_id        TEXT NOT NULL,
  identifier_type  TEXT NOT NULL,    -- 'email' | 'cookie_id' | 'handle' | ...
  identifier_value TEXT NOT NULL,
  method           TEXT,             -- 'email_submit' | 'cookie_lookup' | 'merge' | ...
  source_event_id  TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_links_cookie ON identity_links(cookie_id);
CREATE INDEX IF NOT EXISTS idx_identity_links_person ON identity_links(person_id);
CREATE INDEX IF NOT EXISTS idx_identity_links_value  ON identity_links(identifier_value);
CREATE INDEX IF NOT EXISTS idx_identity_links_type   ON identity_links(identifier_type);
