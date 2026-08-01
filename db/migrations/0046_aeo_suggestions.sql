-- 0046 — AEO suggestions: OSINT signals -> developed angles -> operator approval.
-- A triage stage IN FRONT of aeo_questions: the operator approves a topic +
-- angle before it becomes a real question with a pre-filled "interview" and
-- fires the (existing, unchanged) full write + figures + draft pipeline.
--
-- Status lifecycle: pending -> approved -> drafted   (happy path; question_slug
--                           -> rejected               links to aeo_questions once approved)
--                    approved -> failed               (writer errored; retry via the tool)
CREATE TABLE IF NOT EXISTS aeo_suggestions (
  id             TEXT PRIMARY KEY,
  signal_id      TEXT REFERENCES osint_signals(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,             -- proposed article title / question
  angle          TEXT NOT NULL,             -- Nyyon's developed take (becomes the pre-filled "interview answer")
  rationale      TEXT,                      -- why this is worth writing, one line
  target_keyword TEXT,
  source_name    TEXT,
  source_url     TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | drafted | failed
  question_slug  TEXT,                      -- set once promoted to aeo_questions
  last_error     TEXT,
  created_at     INTEGER NOT NULL,
  decided_at     INTEGER,
  decided_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_aeo_suggestions_status  ON aeo_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_aeo_suggestions_created ON aeo_suggestions(created_at DESC);
