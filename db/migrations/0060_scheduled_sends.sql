-- GTM scheduled sends. The no-duplicate design is structural:
--   * one row per scheduled send, claimed ATOMICALLY (status='scheduled' →
--     'claimed' via conditional UPDATE) before any gateway call — two
--     concurrent runners cannot both claim;
--   * a claimed row NEVER re-arms itself: any ambiguous outcome fails CLOSED
--     (better a missed send than a duplicate);
--   * the partial unique index blocks two live schedules of the same content
--     to the same lead at the database level, not in app code.
CREATE TABLE IF NOT EXISTS scheduled_sends (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL,
  chat_id       TEXT NOT NULL,
  bubbles       TEXT NOT NULL,             -- JSON array of message strings
  content_hash  TEXT NOT NULL,             -- normalized hash of bubbles
  send_at       INTEGER NOT NULL,          -- ms epoch
  status        TEXT NOT NULL DEFAULT 'scheduled',
                -- scheduled | claimed | sent | partial | failed | cancelled
  claim_token   TEXT,
  claimed_at    INTEGER,
  sent_at       INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_sends (status, send_at);
CREATE INDEX IF NOT EXISTS idx_sched_lead ON scheduled_sends (lead_id, created_at);
-- HARD dup-block: at most ONE live (scheduled/claimed) row per lead+content.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_live_dup
  ON scheduled_sends (lead_id, content_hash)
  WHERE status IN ('scheduled', 'claimed');
