-- 0012 — Calendar module.
-- Central event store. Any module (or Nyo) writes events here; the ops Calendar
-- page reads them. Events are deduped per (source, source_ref) so a re-publish
-- of the same blog post updates the existing row instead of stacking duplicates.
--
-- Event kinds shipped today:
--   meeting        — a real scheduled call
--   social_post    — scaffold for the future publishing module (LinkedIn/X/etc.)
--   blog_publish   — auto-written when a blog post is published
--   campaign       — campaign launch / milestone
--   deadline       — internal-or-client deadline
--   other          — escape hatch
--
-- Status lifecycle: pending -> confirmed -> done   (happy path)
--                          -> cancelled            (operator killed it)

CREATE TABLE IF NOT EXISTS calendar_events (
  id               TEXT PRIMARY KEY,                      -- ce_<rand>
  kind             TEXT NOT NULL DEFAULT 'meeting',
  title            TEXT NOT NULL,
  description      TEXT,
  starts_at        INTEGER NOT NULL,                      -- ms epoch
  ends_at          INTEGER,                               -- ms epoch; nullable for all-day or instant events
  all_day          INTEGER NOT NULL DEFAULT 0,            -- 1 = all-day
  status           TEXT NOT NULL DEFAULT 'confirmed',
  source           TEXT NOT NULL DEFAULT 'manual',        -- manual | nyo | blog | aeo | social | external
  source_ref       TEXT,                                  -- e.g. blog_posts.slug, aeo_questions.slug
  link_url         TEXT,                                  -- optional deep link (the related blog post, meeting URL, etc.)
  location         TEXT,
  attendees        TEXT,                                  -- JSON array of {name,email} objects
  body             TEXT,                                  -- long-form: meeting agenda, social-post draft, etc.
  platform         TEXT,                                  -- for social_post: linkedin|x|facebook|tiktok|instagram
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  created_by       TEXT,
  updated_by       TEXT
);

CREATE INDEX        IF NOT EXISTS idx_calendar_events_starts_at  ON calendar_events(starts_at);
CREATE INDEX        IF NOT EXISTS idx_calendar_events_kind       ON calendar_events(kind);
CREATE INDEX        IF NOT EXISTS idx_calendar_events_status     ON calendar_events(status);
CREATE INDEX        IF NOT EXISTS idx_calendar_events_source     ON calendar_events(source);
-- Dedup key for module-written events: same (source, source_ref) upserts in place.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_calendar_events_source_ref
  ON calendar_events(source, source_ref)
  WHERE source_ref IS NOT NULL;

-- ─── backfill: every published blog post becomes a calendar event ───────────
-- 'blog:' || slug keeps the id stable across re-runs so this migration is idempotent.
-- Skipped via INSERT OR IGNORE on the unique (source, source_ref) index if rerun
-- after operator-edited events for the same source already exist.
INSERT OR IGNORE INTO calendar_events
  (id, kind, title, description, starts_at, ends_at, all_day, status, source, source_ref, link_url, body, created_at, updated_at, created_by, updated_by)
SELECT
  'ce_blog_' || slug                AS id,
  'blog_publish'                    AS kind,
  title                             AS title,
  excerpt                           AS description,
  published_at                      AS starts_at,
  NULL                              AS ends_at,
  1                                 AS all_day,
  'done'                            AS status,
  'blog'                            AS source,
  slug                              AS source_ref,
  '/blog/' || slug                  AS link_url,
  NULL                              AS body,
  COALESCE(published_at, updated_at) AS created_at,
  updated_at                        AS updated_at,
  'system-backfill'                 AS created_by,
  updated_by                        AS updated_by
FROM blog_posts
WHERE published = 1 AND published_at IS NOT NULL;

-- ─── seed: a couple of demo events so the empty Calendar isn't a void ───────
INSERT OR IGNORE INTO calendar_events
  (id, kind, title, description, starts_at, ends_at, all_day, status, source, created_at, updated_at, created_by)
VALUES
  (
    'ce_demo_q3_kickoff',
    'campaign',
    'Q3 content sprint kickoff',
    'Planning session for the next 90 days of AEO + paid creative.',
    strftime('%s','now','+3 days','start of day','+10 hours') * 1000,
    strftime('%s','now','+3 days','start of day','+11 hours') * 1000,
    0,
    'confirmed',
    'manual',
    strftime('%s','now') * 1000,
    strftime('%s','now') * 1000,
    'system-seed'
  ),
  (
    'ce_demo_social_linkedin',
    'social_post',
    'LinkedIn — AEO playbook teaser',
    'Tease the AEO writer launch with a 3-bullet ‘we now ship one article a day’ post.',
    strftime('%s','now','+2 days','start of day','+15 hours') * 1000,
    NULL,
    0,
    'pending',
    'manual',
    strftime('%s','now') * 1000,
    strftime('%s','now') * 1000,
    'system-seed'
  );

-- ─── module registry entry ──────────────────────────────────────────────────
INSERT OR REPLACE INTO modules (slug, name, status, description, surface, created_at, updated_at)
VALUES (
  'calendar',
  'Calendar',
  'shipped',
  'Central event store. Any module writes events here; the Calendar page reads them. Blog publishes auto-mirror; meetings + social posts + campaigns + deadlines created manually or by Nyo.',
  'calendar',
  strftime('%s','now') * 1000,
  strftime('%s','now') * 1000
);
