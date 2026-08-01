-- Sunday Brain — weekly editorial planning interview.
--
-- Every Sunday, Nyo interviews the operator (~18 questions across categories:
-- what we shipped, opinions/contrarian takes, live commentary on AI/news,
-- client experience, predictions) and derives the coming week's article slate.
-- Each derived idea becomes an aeo_questions row with interview_status='ready'
-- and the relevant brain answers as expert_context — so the AEO writer can
-- write it WITHOUT a second interview (the brain IS the interview).
CREATE TABLE IF NOT EXISTS brain_sessions (
  id             TEXT PRIMARY KEY,
  week_of        INTEGER NOT NULL,            -- ms-epoch of that week's Sunday 00:00 (local)
  status         TEXT NOT NULL DEFAULT 'open',-- open | derived | archived
  questions_json TEXT,                         -- JSON array of question strings
  answers_text   TEXT,                         -- operator's raw answers (free text)
  derived_json   TEXT,                         -- JSON array of {title, angle, category, target_keyword, question_slug}
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_brain_week   ON brain_sessions(week_of DESC);
CREATE INDEX IF NOT EXISTS idx_brain_status ON brain_sessions(status);
