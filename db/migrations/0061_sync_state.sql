-- Generic cursor storage for pull-syncs. First use: the WhatsApp gateway
-- pull-sync cursors on the store row's created_at (when the gateway persisted
-- it), because the bridge's deaf-window sweep stores days-old messages long
-- after their own timestamps — a ts cursor never sees those.
CREATE TABLE IF NOT EXISTS sync_state (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
