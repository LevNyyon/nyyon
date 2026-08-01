-- Digest channels — sources the digest generator pulls from. Each row is a
-- (source) wired into generateDigest(). Operator can enable/disable a source
-- without touching the underlying table. Mirrors the osint_listeners design.

CREATE TABLE IF NOT EXISTS digest_channels (
  source        TEXT PRIMARY KEY,      -- whatsapp | calendar | osint | email
  label         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,
  cadence       TEXT NOT NULL DEFAULT 'manual',  -- manual | daily | hourly (cron wiring lands later)
  notes         TEXT,
  last_run_at   INTEGER,
  last_status   TEXT,                            -- ok | error
  last_error    TEXT,
  total_runs    INTEGER NOT NULL DEFAULT 0,
  total_added   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

INSERT OR IGNORE INTO digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES
  ('whatsapp', 'WhatsApp (OpenWA)', 1, 'manual', 'Inbound group + DM messages from wa_messages',     unixepoch()*1000, unixepoch()*1000),
  ('calendar', 'Calendar',          1, 'manual', 'Upcoming events in the next 24h from calendar_events', unixepoch()*1000, unixepoch()*1000),
  ('osint',    'OSINT mentions',    1, 'manual', 'High-confidence mentions from any enabled OSINT listener', unixepoch()*1000, unixepoch()*1000),
  ('email',    'Email',             0, 'manual', 'Placeholder · IMAP/Gmail listener lands later',          unixepoch()*1000, unixepoch()*1000);
