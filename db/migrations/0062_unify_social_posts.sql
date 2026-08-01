-- Unify the two social-post stores into one.
--
-- Hot Takes kept its own hot_take_posts table because it needed a package
-- link, a schedule time, and a couple of extra statuses. That fork bought one
-- column's worth of value and cost a whole duplicate set of draft/save/send
-- tools. One table, one set of tools: social_posts gains the columns Hot
-- Takes needed, blog_slug stops being mandatory (a package leg has no blog
-- post until the article is written), and the old rows move across.
--
-- SQLite cannot drop a NOT NULL, so the table is rebuilt. Column order and
-- names are preserved for every existing reader.

CREATE TABLE IF NOT EXISTS social_posts_v2 (
  id           TEXT PRIMARY KEY,
  blog_slug    TEXT,                          -- null until an article exists
  package_id   TEXT,                          -- → hot_take_packages.id (Hot Takes legs)
  channel      TEXT NOT NULL,                 -- linkedin-company | linkedin-personal | facebook-company
  status       TEXT NOT NULL DEFAULT 'draft', -- draft|ready|scheduled|posted|failed|skipped|not_planned
  content      TEXT NOT NULL DEFAULT '',
  notes        TEXT,
  image_url    TEXT,
  error        TEXT,
  outbox_id    TEXT,
  scheduled_at INTEGER,
  posted_at    INTEGER,
  actor        TEXT,
  blog_title   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

INSERT INTO social_posts_v2
  (id, blog_slug, package_id, channel, status, content, notes, image_url, error,
   outbox_id, scheduled_at, posted_at, actor, blog_title, created_at, updated_at)
SELECT id, blog_slug, NULL, channel, status, content, NULL, image_url, error,
       outbox_id, NULL, posted_at, NULL,
       (SELECT blog_title FROM social_posts s2 WHERE s2.id = social_posts.id),
       created_at, updated_at
FROM social_posts;

-- Hot Takes legs: body -> content, package_id carried, blog_slug resolved from
-- the package when its article was already written.
INSERT INTO social_posts_v2
  (id, blog_slug, package_id, channel, status, content, notes, image_url, error,
   outbox_id, scheduled_at, posted_at, actor, blog_title, created_at, updated_at)
SELECT p.id,
       (SELECT pk.blog_slug FROM hot_take_packages pk WHERE pk.id = p.package_id),
       p.package_id, p.channel, p.status, COALESCE(p.body, ''), p.notes, p.image_url,
       p.error, p.outbox_id, p.scheduled_at, p.posted_at, p.actor, NULL,
       p.created_at, p.updated_at
FROM hot_take_posts p;

DROP TABLE social_posts;
ALTER TABLE social_posts_v2 RENAME TO social_posts;
DROP TABLE IF EXISTS hot_take_posts;

CREATE INDEX IF NOT EXISTS idx_social_posts_slug    ON social_posts(blog_slug);
CREATE INDEX IF NOT EXISTS idx_social_posts_status  ON social_posts(status);
CREATE INDEX IF NOT EXISTS idx_social_posts_package ON social_posts(package_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_sched   ON social_posts(scheduled_at);
