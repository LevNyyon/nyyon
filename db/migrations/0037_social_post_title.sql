-- Carry the source article's title on each social post row, so the UI (and the
-- Outbox) can show what a post is related to without a join/lookup. Backfill
-- existing rows from blog_posts.

ALTER TABLE social_posts ADD COLUMN blog_title TEXT;

UPDATE social_posts
   SET blog_title = (SELECT title FROM blog_posts WHERE blog_posts.slug = social_posts.blog_slug)
 WHERE blog_title IS NULL;
