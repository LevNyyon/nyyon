-- Per-article voice selector. 'house' = the default brand voice (most posts).
-- 'personal' = layer the operator's personal voice on top, for opinion /
-- thought-leadership pieces only.
ALTER TABLE aeo_questions ADD COLUMN voice TEXT NOT NULL DEFAULT 'house';
