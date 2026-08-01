-- AEO feedback — the operator's reactions to Nyo's article/question ideas.
-- Every "love it / too generic / make it about X / kill it" reaction is logged
-- here, tied to a question slug when one exists (or just the idea title when
-- it's a raw suggestion). Accumulated feedback is distilled into the
-- `nyyon-editorial-taste` knowledge doc, which the question generators read —
-- so Nyo's ideas get sharper over time.
CREATE TABLE IF NOT EXISTS aeo_feedback (
  id            TEXT PRIMARY KEY,
  question_slug TEXT,                          -- aeo_questions.slug if it maps to a saved question
  idea_title    TEXT,                          -- the idea as proposed (for unsaved suggestions)
  reaction      TEXT NOT NULL,                 -- love | like | meh | reject | edit
  note          TEXT,                          -- the operator's words: why, or how to change it
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aeo_feedback_slug    ON aeo_feedback(question_slug);
CREATE INDEX IF NOT EXISTS idx_aeo_feedback_created ON aeo_feedback(created_at DESC);
