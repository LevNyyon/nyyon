-- Hot Takes — the editorial "publication package" store. One row per editorial
-- piece, carrying it across the whole pipeline: topic → take (POV) → brief →
-- article → review → schedule → publish/distribute. The five Hot Takes tabs are
-- VIEWS over these two tables, not separate products.
--
-- The article BODY itself lives in blog_posts (linked here by blog_slug) so Hot
-- Takes reuses the existing blog publish + edge-render pipeline untouched. Social
-- legs live in hot_take_posts (package-scoped) so the Social module's own queue
-- is never polluted. Follows the 0054 pattern: IF NOT EXISTS + indexes,
-- created_at/updated_at INTEGER (ms epoch), no seed rows.

CREATE TABLE IF NOT EXISTS hot_take_packages (
  id                TEXT PRIMARY KEY,                    -- ht_<rand>
  status            TEXT NOT NULL DEFAULT 'topic',       -- topic|take|brief|article|review|ready|scheduled|published|complete|dismissed|archived
  title             TEXT,
  -- topic layer
  summary           TEXT,
  why_it_matters    TEXT,
  source_name       TEXT,
  source_url        TEXT,
  published_at      INTEGER,                             -- source publish time (ms)
  origin            TEXT,                                -- osint_topic|osint_signal|digest|link|manual
  origin_ref        TEXT,                                -- id/url of the origin row (dedupe key vs the live feed)
  multi_source_json TEXT,                                -- [{title,url}] additional coverage
  pinned            INTEGER NOT NULL DEFAULT 0,
  -- take (point of view)
  take              TEXT,
  believe           TEXT,                                -- the 4 take-inputs
  misunderstood     TEXT,
  who_cares         TEXT,
  reader_action     TEXT,
  -- brief
  brief_json        TEXT,                                -- {argument,audience,why_now,points[],evidence,objections,conclusion}
  -- article (body lives in blog_posts, linked by slug)
  blog_slug         TEXT,
  headline          TEXT,
  intro             TEXT,
  -- review
  review_json       TEXT,                                -- {claims:[{text,source,type,status}], quality_flags:[{kind,section,note,severity,resolved}]}
  -- notes (kept visually separate from the final post text)
  company_notes     TEXT,
  author_notes      TEXT,
  -- distribution / schedule (the website leg of the release)
  website_status    TEXT NOT NULL DEFAULT 'not_planned', -- not_planned|planned|scheduled|published
  website_url       TEXT,
  scheduled_at      INTEGER,                             -- website publish time (ms)
  -- meta
  actor             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hot_take_packages_status  ON hot_take_packages (status);
CREATE INDEX IF NOT EXISTS idx_hot_take_packages_updated ON hot_take_packages (updated_at);
CREATE INDEX IF NOT EXISTS idx_hot_take_packages_pinned  ON hot_take_packages (pinned);
CREATE INDEX IF NOT EXISTS idx_hot_take_packages_origin  ON hot_take_packages (origin_ref);
CREATE INDEX IF NOT EXISTS idx_hot_take_packages_slug    ON hot_take_packages (blog_slug);

-- Per-leg social distribution (company + personal LinkedIn). Mirrors the
-- social_posts shape but package-scoped. channel values come from the social
-- gateway's CONNECTIONS map (linkedin-company | linkedin-personal) — never a
-- third hardcoded copy of the channel list.
CREATE TABLE IF NOT EXISTS hot_take_posts (
  id           TEXT PRIMARY KEY,                         -- htp_<rand>
  package_id   TEXT NOT NULL,                            -- → hot_take_packages.id
  channel      TEXT NOT NULL,                            -- linkedin-company | linkedin-personal
  body         TEXT,
  notes        TEXT,
  image_url    TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',            -- draft|ready|scheduled|posted|skipped|failed|not_planned
  scheduled_at INTEGER,
  posted_at    INTEGER,
  outbox_id    TEXT,
  error        TEXT,
  actor        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hot_take_posts_package ON hot_take_posts (package_id);
CREATE INDEX IF NOT EXISTS idx_hot_take_posts_status  ON hot_take_posts (status);
CREATE INDEX IF NOT EXISTS idx_hot_take_posts_sched   ON hot_take_posts (scheduled_at);
