-- OSINT hot topics — the synthesis/value layer on top of osint_signals.
-- heartbeat.js scores individual signals; synthesizeHotTopics() clusters the
-- strongest into discrete, blog-grade "hot topics with a Nyyon angle" so the
-- Digest can quote each one (pullOsintInsights -> kind='osint_insight').
-- ensureTopicsTable() in heartbeat.js creates this at runtime too; this file is
-- the canonical record for fresh deploys.
CREATE TABLE IF NOT EXISTS osint_topics (
  id           TEXT PRIMARY KEY,            -- djb2 hash of normalized title (recurring topics dedupe)
  title        TEXT NOT NULL,               -- <=65-char sharp declarative claim
  thesis       TEXT,                        -- 2-3 sentences: the move + the non-obvious take
  why_now      TEXT,                        -- what just changed
  angle        TEXT,                        -- the earned Nyyon angle
  format       TEXT,                        -- 'blog' | 'social' | 'both'
  heat         INTEGER,                     -- 0-100
  sources_json TEXT,                        -- [{title,url}] of the signals it draws on
  status       TEXT NOT NULL DEFAULT 'new', -- new | surfaced | actioned | dismissed
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_osint_topics_heat    ON osint_topics(heat DESC);
CREATE INDEX IF NOT EXISTS idx_osint_topics_created ON osint_topics(created_at DESC);
