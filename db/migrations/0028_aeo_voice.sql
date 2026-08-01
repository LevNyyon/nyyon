-- Per-article voice selector. 'house' = default Nyyon brand voice (most posts).
-- 'lev' = layer the founder's personal voice (nyyon-voice-lev) on top — for
-- opinion / thought-leadership pieces only.
ALTER TABLE aeo_questions ADD COLUMN voice TEXT NOT NULL DEFAULT 'house';
