-- 0020 — Nyo pending messages.
-- Queue of assistant turns that background work (cron, hooks, etc) wants Nyo
-- to surface in the chat. The Chat component polls /api/nyo/pending, injects
-- undelivered rows as assistant messages, and POSTs /deliver to clear them.
--
-- Triggers the existing `hasUnseen` chat-state flag → badge on the floating
-- Nyo button + sidebar entry. The operator never sees the queue directly;
-- they just notice the badge and open Nyo to read what happened.

CREATE TABLE IF NOT EXISTS nyo_messages (
  id           TEXT PRIMARY KEY,        -- nyo_<rand>
  content      TEXT NOT NULL,           -- markdown / plain text the chat will render as the assistant
  kind         TEXT,                    -- aeo_published | blog_image | system | manual | error
  ref_kind     TEXT,                    -- optional: source table (e.g. blog_posts)
  ref_id       TEXT,                    -- optional: source row id (e.g. blog slug)
  payload_json TEXT,                    -- optional: structured side-data (e.g. {url, scores})
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER                  -- null = pending, set when chat has injected it
);

CREATE INDEX IF NOT EXISTS idx_nyo_messages_pending ON nyo_messages(delivered_at);
CREATE INDEX IF NOT EXISTS idx_nyo_messages_created ON nyo_messages(created_at DESC);
