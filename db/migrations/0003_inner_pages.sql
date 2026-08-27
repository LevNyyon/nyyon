-- 0003 — blog_posts table for inner pages.
-- Ships empty: posts are created via the ops UI (or the write_blog_post tool).

CREATE TABLE IF NOT EXISTS blog_posts (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  excerpt TEXT,
  body TEXT,
  tags TEXT,                     -- JSON array
  published_at INTEGER,          -- ms epoch of intended publish date
  published INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at ON blog_posts(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published    ON blog_posts(published);

-- Seed content (blog post stubs, legal-hub page blocks, and comparison-page
-- blocks) removed for the shipped product; the operator adds inner-page
-- content from the ops UI.
