-- 0038: WhatsApp meeting reminders. A self-message fires N minutes before a
-- calendar meeting. Dedup = reminded_at on the event row; config = single row.
ALTER TABLE calendar_events ADD COLUMN reminded_at INTEGER;

CREATE TABLE IF NOT EXISTS meeting_reminder_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  lead_minutes INTEGER NOT NULL DEFAULT 10,
  chat_id TEXT,                            -- NULL -> env.WA_TEST_CHAT_ID (own chat)
  kinds TEXT NOT NULL DEFAULT 'meeting',   -- comma list of calendar_events.kind values
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO meeting_reminder_settings (id) VALUES (1);
