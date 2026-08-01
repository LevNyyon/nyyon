-- Social module: auto-drafted social posts from published blog articles.
--
-- One row per (blog post × channel). When a blog post goes live, the publish
-- hook drops three drafts here (company LinkedIn, personal LinkedIn, company
-- Facebook). The operator approves each in the Social module, which POSTs it
-- through the Make-webhook gateway (lib/social-gateway.js) and logs the send to
-- the Outbox + activity feed.

CREATE TABLE IF NOT EXISTS social_posts (
  id          TEXT PRIMARY KEY,
  blog_slug   TEXT NOT NULL,
  channel     TEXT NOT NULL,                 -- linkedin-company | linkedin-personal | facebook-company
  status      TEXT NOT NULL DEFAULT 'draft', -- draft | posted | failed | skipped
  content     TEXT NOT NULL,
  image_url   TEXT,
  error       TEXT,
  outbox_id   TEXT,                          -- the outbound_log row created on release
  posted_at   INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_social_posts_slug   ON social_posts(blog_slug);
CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts(status);

-- Register the module so it shows in the modules list / sidebar registry.
INSERT OR REPLACE INTO modules (slug, name, status, description, surface, created_at, updated_at)
VALUES (
  'social',
  'Social',
  'shipped',
  'Every published article auto-drafts LinkedIn + Facebook posts in brand/personal voice; approve to push through the gateways. Releases log to Outbox + activity.',
  'social',
  strftime('%s','now') * 1000,
  strftime('%s','now') * 1000
);
