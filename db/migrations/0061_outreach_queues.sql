-- Named outreach queues, so prospects can be grouped into campaigns instead of
-- one undifferentiated pile.
--
-- THE ANTI-SPAM RULE IS THE SCHEMA. `outreach_queue.lead_id` stays the PRIMARY
-- KEY, so a person can hold exactly one enrolment across ALL queues — being in
-- two campaigns at once is not something the engine has to remember to check,
-- it is something the database cannot represent. Adding someone already
-- enrolled elsewhere is a conflict the operator must explicitly override, and
-- the override MOVES them rather than duplicating them.

CREATE TABLE IF NOT EXISTS outreach_queues (
  id          TEXT PRIMARY KEY,        -- 'oq_...'
  name        TEXT NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
-- Two queues with the same name would make the picker a coin toss.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_queues_name ON outreach_queues (name);

-- Which queue an enrolment belongs to. Nullable so the ALTER is safe on an
-- existing table; every row is backfilled to the default queue below, and the
-- code treats NULL as the default too.
ALTER TABLE outreach_queue ADD COLUMN queue_id TEXT;
CREATE INDEX IF NOT EXISTS idx_outreach_queue_queue ON outreach_queue (queue_id, status);

-- A home for anything enrolled before queues existed.
INSERT OR IGNORE INTO outreach_queues (id, name, note, created_at, updated_at)
VALUES ('oq_default', 'General outreach', 'The default queue — everything enrolled before named queues existed.',
        strftime('%s','now')*1000, strftime('%s','now')*1000);

UPDATE outreach_queue SET queue_id = 'oq_default' WHERE queue_id IS NULL;
