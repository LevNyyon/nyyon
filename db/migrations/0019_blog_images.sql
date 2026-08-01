-- 0019 — Featured images for blog posts.
-- Storage is the `nyyon-assets` R2 bucket (binding ASSETS). The URL stored
-- here is the same-origin path served by the worker (e.g. /assets/blog/<slug>.png),
-- not a raw R2 URL — that way the path survives a future swap to a custom
-- domain without touching post rows.
--
-- prompt + model are captured so the operator can read what produced the
-- image and so the regenerate path can fall back to the original prompt.

ALTER TABLE blog_posts ADD COLUMN featured_image_url          TEXT;
ALTER TABLE blog_posts ADD COLUMN featured_image_prompt       TEXT;
ALTER TABLE blog_posts ADD COLUMN featured_image_model        TEXT;
ALTER TABLE blog_posts ADD COLUMN featured_image_generated_at INTEGER;
