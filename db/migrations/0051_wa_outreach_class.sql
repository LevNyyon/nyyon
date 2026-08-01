-- Per-message verdict: is this outbound WhatsApp message a genuine OUTREACH
-- pitch (aligned with our outreach content) vs a follow-up / reply / personal
-- message? The KPI's WhatsApp count reads the message content to tell them
-- apart — this table caches each verdict so we classify a message once (an LLM
-- call) and then count cheaply. Keyed by wa_messages.id (TEXT).
CREATE TABLE IF NOT EXISTS wa_outreach_class (
  msg_id        TEXT PRIMARY KEY,     -- wa_messages.id
  chat_id       TEXT,
  is_outreach   INTEGER NOT NULL,     -- 1 = genuine outreach pitch, 0 = not
  reason        TEXT,                 -- short model rationale (for auditing)
  classified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wa_outreach_class_chat ON wa_outreach_class (chat_id, is_outreach);
