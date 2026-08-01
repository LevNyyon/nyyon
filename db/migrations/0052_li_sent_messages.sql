-- LinkedIn messages the operator SENT, synced from the linkedin-gateway daemon
-- (both engine sends and DMs sent by hand on linkedin.com — the inbox is the
-- single source of truth). This is the LinkedIn analogue of wa_messages'
-- from_me=1 rows, and feeds the outreach KPI. Each row carries a content
-- classification (is_outreach) just like wa_outreach_class, so the KPI counts
-- genuine outreach and not follow-ups / personal replies.
CREATE TABLE IF NOT EXISTS li_sent_messages (
  id               TEXT PRIMARY KEY,   -- stable hash of conversation_urn + at
  conversation_urn TEXT,
  recipient_urn    TEXT,
  name             TEXT,               -- participant display name (best-effort; may be null)
  body             TEXT,
  at               INTEGER,            -- ms epoch (deliveredAt)
  is_outreach      INTEGER,            -- 1 genuine outreach, 0 not, NULL = unclassified
  reason           TEXT,
  synced_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_li_sent_messages_at ON li_sent_messages (at);
CREATE INDEX IF NOT EXISTS idx_li_sent_messages_outreach ON li_sent_messages (is_outreach, at);
