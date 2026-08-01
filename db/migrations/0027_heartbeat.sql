-- OSINT v2 — the awareness layer (industry heartbeat).
-- Replaces the HN keyword firehose with authoritative RSS + Google News feeds,
-- LLM-scored into signals. Old osint_targets/osint_mentions stay for now (brand
-- watch) but the heartbeat runs on these two tables.

-- Feeds we pull: company-blog RSS + Google News RSS topic queries.
CREATE TABLE IF NOT EXISTS osint_sources (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,              -- 'rss' (company blog/news feed) | 'gnews' (Google News query)
  name            TEXT NOT NULL,              -- display name e.g. "OpenAI Blog", "Topic: AEO"
  url             TEXT NOT NULL,              -- feed URL (for gnews, the news.google.com/rss/search URL)
  theme           TEXT,                       -- 'models' | 'ai-marketing' | 'aeo' | 'competitor' | 'brand' | 'general'
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_fetched_at INTEGER,
  last_status     TEXT,                       -- 'ok' | 'error'
  last_error      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_osint_sources_enabled ON osint_sources(enabled);

-- Individual items pulled from sources, scored for relevance + content value.
CREATE TABLE IF NOT EXISTS osint_signals (
  id              TEXT PRIMARY KEY,
  source_id       TEXT REFERENCES osint_sources(id) ON DELETE SET NULL,
  source_name     TEXT,                       -- denormalised for display
  theme           TEXT,
  title           TEXT NOT NULL,
  url             TEXT NOT NULL UNIQUE,        -- dedupe key
  summary         TEXT,
  published_at    INTEGER,
  -- scoring (filled by the LLM pass; null until scored)
  relevance       INTEGER,                     -- 0-100: is this relevant to Nyyon's world?
  why             TEXT,                        -- one-line rationale
  content_score   INTEGER,                     -- 0-100: how write-about-able / post-able is it?
  formats         TEXT,                        -- csv: 'blog','social' (what it could become)
  suggested_angle TEXT,                        -- the angle Nyyon would take
  status          TEXT NOT NULL DEFAULT 'new', -- new | scored | surfaced | actioned | dismissed
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_osint_signals_status    ON osint_signals(status);
CREATE INDEX IF NOT EXISTS idx_osint_signals_score     ON osint_signals(content_score DESC);
CREATE INDEX IF NOT EXISTS idx_osint_signals_published ON osint_signals(published_at DESC);
