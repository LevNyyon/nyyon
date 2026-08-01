-- 0007 — WhatsApp listener tables, a shared OpenWA-compatible gateway.
-- Pattern adapted from an earlier OpenWA integration, renamed
-- with wa_* prefix so both projects can coexist on the same machine.

CREATE TABLE IF NOT EXISTS wa_chats (
  id TEXT PRIMARY KEY,                -- OpenWA chat id, e.g. '972545492444@c.us' or '120363406565660808@g.us'
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  auto_listen INTEGER NOT NULL DEFAULT 0,   -- 1 = persist + surface inbound. Default off — operator opts in.
  can_send INTEGER NOT NULL DEFAULT 0,      -- reserved for Phase 2 outbound
  last_message_at INTEGER,
  last_snippet TEXT,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_chats_auto_listen ON wa_chats(auto_listen);
CREATE INDEX IF NOT EXISTS idx_wa_chats_last_msg    ON wa_chats(last_message_at DESC);

CREATE TABLE IF NOT EXISTS wa_messages (
  id TEXT PRIMARY KEY,                -- OpenWA message id — dedup key (echoes from outbound self-skip via INSERT OR IGNORE)
  chat_id TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  sender_id TEXT,                     -- e.g. '972545492444@c.us'
  sender_name TEXT,
  body TEXT,
  timestamp INTEGER NOT NULL,         -- ms epoch (normalised from OpenWA's seconds)
  raw_json TEXT,                      -- full OpenWA payload for forensic / replay
  person_id TEXT,                     -- linked identity after phone-based stitching
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_chat      ON wa_messages(chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_person    ON wa_messages(person_id);
CREATE INDEX IF NOT EXISTS idx_wa_messages_timestamp ON wa_messages(timestamp DESC);
