-- 0018 — Outbox (unified outbound send log).
-- Every outbound message — WhatsApp, LinkedIn, future email/SMS — passes
-- through send helpers in workers/api/src/lib/{whatsapp,linkedin}.js. Today
-- a send that fails throws to the UI and vanishes; success persists to
-- channel-specific tables but with no `status` or `error` field.
--
-- The Outbox is the operator's single pane on "what did we try to send, did
-- it land, and why not?" The send wrappers insert a `queued` row before the
-- attempt, then update to `sent` (with provider message_id) or `failed` (with
-- the error text) when the call returns. Failed rows expose a Retry button
-- that re-fires the original payload.
--
-- This is an append-only audit log; we never delete rows. Retries create new
-- rows that link back to the original via `parent_id`.

CREATE TABLE IF NOT EXISTS outbound_log (
  id           TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,                 -- 'wa' | 'li' | 'email' | 'sms'
  kind         TEXT NOT NULL,                 -- 'text' | 'reply' | 'image' | 'document' | 'reaction'
  to_id        TEXT,                          -- chat_id / profile_urn / email_addr / phone — provider-native
  to_name      TEXT,                          -- best-effort display name resolved at send time
  body         TEXT,                          -- text content (or caption for media)
  payload_json TEXT,                          -- full args (url, filename, quotedMessageId, etc.) — JSON
  status       TEXT NOT NULL,                 -- 'queued' | 'sent' | 'failed'
  message_id   TEXT,                          -- provider's id on success (OpenWA msg id, LI urn, etc.)
  error        TEXT,                          -- error text on failure
  attempt      INTEGER NOT NULL DEFAULT 1,    -- 1 for first try, 2+ for retries
  parent_id    TEXT,                          -- original outbound_log.id when this row is a retry
  source       TEXT,                          -- 'digest' | 'nyo' | 'operator' | 'channel' | 'wa-test' | 'channels-ui'
  source_ref   TEXT,                          -- digest_item_id / nyo_turn_id / etc.
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_created  ON outbound_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_status   ON outbound_log(status);
CREATE INDEX IF NOT EXISTS idx_outbox_channel  ON outbound_log(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_source   ON outbound_log(source, source_ref);
CREATE INDEX IF NOT EXISTS idx_outbox_parent   ON outbound_log(parent_id);

-- Register the surface so it shows up in the module browser + sidebar picker.
INSERT OR REPLACE INTO modules (slug, name, status, description, surface, created_at, updated_at)
VALUES (
  'outbox',
  'Outbox',
  'shipped',
  'Unified send log across WhatsApp, LinkedIn, and future channels. Every outbound attempt is queued, sent, or failed; failed rows expose the underlying error and a one-click retry.',
  'outbox',
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);
