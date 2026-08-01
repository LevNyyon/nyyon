-- 0005 — funnel: web_events table + person_id + click IDs on sessions.

-- ALTER TABLE sessions — add person link + click IDs for future Google Ads attribution.
ALTER TABLE sessions ADD COLUMN person_id TEXT;
ALTER TABLE sessions ADD COLUMN gclid     TEXT;
ALTER TABLE sessions ADD COLUMN gbraid    TEXT;
ALTER TABLE sessions ADD COLUMN wbraid    TEXT;
ALTER TABLE sessions ADD COLUMN fbclid    TEXT;
ALTER TABLE sessions ADD COLUMN msclkid   TEXT;
ALTER TABLE sessions ADD COLUMN ttclid    TEXT;
ALTER TABLE sessions ADD COLUMN browser   TEXT;
ALTER TABLE sessions ADD COLUMN os        TEXT;
ALTER TABLE sessions ADD COLUMN device    TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_person ON sessions(person_id);
CREATE INDEX IF NOT EXISTS idx_sessions_gclid  ON sessions(gclid);

-- New table: web_events — every prospect action on the public site.
-- Distinct from the ops `events` table (which is the operator activity log).
CREATE TABLE IF NOT EXISTS web_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  cookie_id  TEXT,
  person_id  TEXT,
  event_type TEXT NOT NULL,    -- visit | scroll_depth | cta_click | button_click | preq_submit | form_lead | form_mql | form_booked | ...
  event_data TEXT,             -- JSON
  page_path  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_events_session ON web_events(session_id);
CREATE INDEX IF NOT EXISTS idx_web_events_cookie  ON web_events(cookie_id);
CREATE INDEX IF NOT EXISTS idx_web_events_person  ON web_events(person_id);
CREATE INDEX IF NOT EXISTS idx_web_events_type    ON web_events(event_type);
CREATE INDEX IF NOT EXISTS idx_web_events_created ON web_events(created_at DESC);
