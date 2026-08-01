-- Per-conversation outreach thread stats behind the Digest KPI drawer: did they
-- reply, is it a longer back-and-forth, is there a reply you haven't caught yet,
-- and how did they feel. Keyed by the conversation: WhatsApp chat_id or LinkedIn
-- conversation_urn. Sentiment is LLM-scored on the latest inbound and cached
-- (re-scored only when a newer inbound arrives).
CREATE TABLE IF NOT EXISTS outreach_threads (
  key               TEXT PRIMARY KEY,   -- wa chat_id | li conversation_urn
  channel           TEXT NOT NULL,      -- 'whatsapp' | 'linkedin'
  name              TEXT,
  replied           INTEGER DEFAULT 0,  -- 1 = they sent at least one inbound after our first outreach
  uncaught          INTEGER DEFAULT 0,  -- 1 = they replied and the LATEST message is theirs (you haven't responded)
  msgs_in           INTEGER DEFAULT 0,
  msgs_out          INTEGER DEFAULT 0,
  last_inbound_text TEXT,
  last_inbound_at   INTEGER,
  sentiment         TEXT,               -- 'positive' | 'neutral' | 'negative' | NULL
  sentiment_reason  TEXT,
  sentiment_at      INTEGER,            -- last_inbound_at the sentiment was scored for (dedupe)
  updated_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outreach_threads_uncaught ON outreach_threads (uncaught, updated_at);
