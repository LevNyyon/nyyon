-- Digest — morning brief module. Pulls actionable items from WA groups,
-- OSINT mentions, email (later), surfaces them in one easy-to-read feed.
-- Operator marks items read/starred to dismiss or pin.

CREATE TABLE IF NOT EXISTS digest_items (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,          -- wa_message | wa_group | osint_mention | email | note | opportunity
  ref_kind         TEXT,                   -- source table name (e.g. 'wa_messages')
  ref_id           TEXT,                   -- source record id, for "open source"
  title            TEXT NOT NULL,
  summary          TEXT,
  source_label     TEXT,                   -- "WA · Nyyon investors", "r/saas", "Inbox · Sarah"
  source_url       TEXT,
  urgency          INTEGER NOT NULL DEFAULT 2,  -- 1 = high, 2 = medium, 3 = low
  actionable       INTEGER NOT NULL DEFAULT 0,  -- 0/1
  suggested_action TEXT,                   -- short verb phrase, e.g. "Reply to Sarah", "Reach out"
  starred          INTEGER NOT NULL DEFAULT 0,  -- 0/1
  read_at          INTEGER,                -- null = unread, else ms epoch
  created_at       INTEGER NOT NULL,
  meta_json        TEXT
);
CREATE INDEX IF NOT EXISTS idx_digest_items_created   ON digest_items(created_at);
CREATE INDEX IF NOT EXISTS idx_digest_items_read      ON digest_items(read_at);
CREATE INDEX IF NOT EXISTS idx_digest_items_urgency   ON digest_items(urgency);
CREATE INDEX IF NOT EXISTS idx_digest_items_kind      ON digest_items(kind);

-- Seed rows removed 2026-06-01.
--
-- The original migration inserted 5 hand-written digest items (`seed_1`
-- through `seed_5`) as placeholder content "so the UI isn't empty on first
-- load." This was the wrong call — the rows looked indistinguishable from
-- real LLM-generated digest items (Michal Hasson asking for a call, an
-- Israel SaaS Founders RFP, etc.), and operators reasonably read them as
-- actual events.
--
-- Nothing in this product should ever fabricate inbound activity. The
-- empty-state in the brief is the truth when no real items exist; the
-- generate() pass populates real ones from WhatsApp + OSINT.
--
-- DO NOT reintroduce seed digest items. If a placeholder UI is needed,
-- handle it client-side as an empty state, not as fake rows in the DB.
