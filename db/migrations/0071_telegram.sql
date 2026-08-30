-- 0071 — Nyo on Telegram: the message store behind the operator's direct line.
-- One row per message either way; context for each answer is read from here.
-- Chat pairing lives in the `nyo-telegram` knowledge doc, not in a table —
-- it is an editable rule, and the doc is where those live.
CREATE TABLE IF NOT EXISTS telegram_messages (
  id        TEXT PRIMARY KEY,   -- tg_<chat>_<message_id> inbound / tg_out_* replies
  chat_id   TEXT NOT NULL,
  from_me   INTEGER NOT NULL DEFAULT 0,
  body      TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat ON telegram_messages(chat_id, timestamp DESC);
