-- OSINT module — port of inrepute's review-intelligence scrapers.
-- Targets are companies/competitors/brands we monitor.
-- Mentions are public reviews + mentions harvested from reddit, hn,
-- stackoverflow, github, appstore RSS, and owned-site testimonial pages.

CREATE TABLE IF NOT EXISTS osint_targets (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  domain       TEXT,            -- e.g. acme.com
  app_id       TEXT,            -- Apple App Store ID, for appstore RSS
  notes        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   TEXT,
  updated_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_osint_targets_name   ON osint_targets(name);
CREATE INDEX IF NOT EXISTS idx_osint_targets_domain ON osint_targets(domain);

CREATE TABLE IF NOT EXISTS osint_mentions (
  id           TEXT PRIMARY KEY,        -- deterministic hash (source + url + text excerpt)
  target_id    TEXT NOT NULL REFERENCES osint_targets(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,           -- reddit | hn | stackoverflow | github | appstore | website
  source_url   TEXT,
  reviewer     TEXT,
  rating       INTEGER,                 -- 1..5 if applicable, else NULL
  text         TEXT NOT NULL,           -- truncated to 2000 chars
  posted_at    INTEGER,                 -- ms epoch
  confidence   REAL,                    -- 0..1 from scoreMention()
  kind         TEXT NOT NULL DEFAULT 'mention',  -- review | mention
  raw_json     TEXT,                    -- minimal raw payload, JSON
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_osint_mentions_target    ON osint_mentions(target_id);
CREATE INDEX IF NOT EXISTS idx_osint_mentions_source    ON osint_mentions(source);
CREATE INDEX IF NOT EXISTS idx_osint_mentions_posted_at ON osint_mentions(posted_at);

-- Seed: monitor Nyyon itself + one fictional competitor so the module has
-- a useful demo state immediately.
INSERT OR IGNORE INTO osint_targets (id, name, domain, app_id, notes, created_at, updated_at, created_by)
VALUES
  ('tgt_nyyon',  'Nyyon',          'nyyon.com',  NULL, 'self · monitor what people say about us',          unixepoch()*1000, unixepoch()*1000, 'system'),
  ('tgt_inrepute','Inrepute',       'inrepute.com', NULL, 'sibling project · cross-monitor',                 unixepoch()*1000, unixepoch()*1000, 'system');
