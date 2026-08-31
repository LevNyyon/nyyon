-- Digest module → digest plugin pack. The digest lived inside the editorial
-- pack's interim port (0074 moved the legacy digest_items / digest_channels
-- into plugin_editorial_digest_*); ownership now moves to the dedicated
-- `digest` pack. Guarded copy so it works on fresh AND existing installs,
-- re-runnable.
--
-- NOTE: the plugin_editorial_digest_* source tables are NOT dropped here —
-- the editorial pack still declares them until its digest-strip pass lands;
-- dropping them under an installed pack would break it. The strip pass owns
-- that removal. INSERT OR IGNORE keeps this copy idempotent either way.

-- ── original legacy names (recipe shape; 0074 already retired them, so on
--    every real install this creates empty shells, copies nothing, drops) ──
CREATE TABLE IF NOT EXISTS digest_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_kind TEXT, ref_id TEXT, title TEXT NOT NULL, summary TEXT, source_label TEXT, source_url TEXT, urgency INTEGER NOT NULL DEFAULT 2, actionable INTEGER NOT NULL DEFAULT 0, suggested_action TEXT, starred INTEGER NOT NULL DEFAULT 0, read_at INTEGER, created_at INTEGER NOT NULL, meta_json TEXT);
CREATE TABLE IF NOT EXISTS digest_channels (source TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'manual', notes TEXT, last_run_at INTEGER, last_status TEXT, last_error TEXT, total_runs INTEGER NOT NULL DEFAULT 0, total_added INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

-- ── the pack's own tables ──
CREATE TABLE IF NOT EXISTS plugin_digest_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_kind TEXT, ref_id TEXT, title TEXT NOT NULL, summary TEXT, source_label TEXT, source_url TEXT, urgency INTEGER NOT NULL DEFAULT 2, actionable INTEGER NOT NULL DEFAULT 0, suggested_action TEXT, starred INTEGER NOT NULL DEFAULT 0, read_at INTEGER, created_at INTEGER NOT NULL, meta_json TEXT);
CREATE INDEX IF NOT EXISTS idx_plugin_digest_items_created_at ON plugin_digest_items (created_at);
CREATE INDEX IF NOT EXISTS idx_plugin_digest_items_read_at ON plugin_digest_items (read_at);
CREATE TABLE IF NOT EXISTS plugin_digest_channels (source TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'manual', notes TEXT, last_run_at INTEGER, last_status TEXT, last_error TEXT, total_runs INTEGER NOT NULL DEFAULT 0, total_added INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_digest_signal_snoozes (key TEXT PRIMARY KEY, until INTEGER NOT NULL, label TEXT, reason TEXT, created_at INTEGER NOT NULL, engaged_count INTEGER NOT NULL DEFAULT 0, last_engaged_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_plugin_digest_signal_snoozes_until ON plugin_digest_signal_snoozes (until);
CREATE TABLE IF NOT EXISTS plugin_digest_wa_queue (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', not_before INTEGER, source TEXT, source_ref TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, message_id TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS idx_plugin_digest_wa_queue_due ON plugin_digest_wa_queue (status, not_before);

-- ── copy: original legacy first (no-op on 0074-lineage installs) ──
INSERT OR IGNORE INTO plugin_digest_items (id, kind, ref_kind, ref_id, title, summary, source_label, source_url, urgency, actionable, suggested_action, starred, read_at, created_at, meta_json) SELECT id, kind, ref_kind, ref_id, title, summary, source_label, source_url, urgency, actionable, suggested_action, starred, read_at, created_at, meta_json FROM digest_items;
INSERT OR IGNORE INTO plugin_digest_channels (source, label, enabled, cadence, notes, last_run_at, last_status, last_error, total_runs, total_added, created_at, updated_at) SELECT source, label, enabled, cadence, notes, last_run_at, last_status, last_error, total_runs, total_added, created_at, updated_at FROM digest_channels;
DROP TABLE digest_items;
DROP TABLE digest_channels;

-- ── copy: the editorial pack's interim digest tables (the real handoff) ──
CREATE TABLE IF NOT EXISTS plugin_editorial_digest_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_kind TEXT, ref_id TEXT, title TEXT NOT NULL, summary TEXT, source_label TEXT, source_url TEXT, urgency INTEGER NOT NULL DEFAULT 2, actionable INTEGER NOT NULL DEFAULT 0, suggested_action TEXT, starred INTEGER NOT NULL DEFAULT 0, read_at INTEGER, created_at INTEGER NOT NULL, meta_json TEXT);
CREATE TABLE IF NOT EXISTS plugin_editorial_digest_channels (source TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'manual', notes TEXT, last_run_at INTEGER, last_status TEXT, last_error TEXT, total_runs INTEGER NOT NULL DEFAULT 0, total_added INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO plugin_digest_items (id, kind, ref_kind, ref_id, title, summary, source_label, source_url, urgency, actionable, suggested_action, starred, read_at, created_at, meta_json) SELECT id, kind, ref_kind, ref_id, title, summary, source_label, source_url, urgency, actionable, suggested_action, starred, read_at, created_at, meta_json FROM plugin_editorial_digest_items;
INSERT OR IGNORE INTO plugin_digest_channels (source, label, enabled, cadence, notes, last_run_at, last_status, last_error, total_runs, total_added, created_at, updated_at) SELECT source, label, enabled, cadence, notes, last_run_at, last_status, last_error, total_runs, total_added, created_at, updated_at FROM plugin_editorial_digest_channels;

-- ── seed every channel row (INSERT OR IGNORE: an existing row's toggle wins) ──
INSERT OR IGNORE INTO plugin_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('attention', 'System attention', 1, 'hourly', 'Cards when the system needs the operator: empty outreach pool, thin publishing pipeline.', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('li_signals', 'LinkedIn signals', 0, 'hourly', 'Mirrors NEW LinkedIn signals into the feed as actionable cards. Dormant until the host carries an li_signals feed.', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('osint_insights', 'OSINT insights', 1, 'hourly', 'Synthesized hot-topic angles — leads the brief (urgency 1).', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('whatsapp', 'WhatsApp', 1, 'manual', 'Inbound group + DM messages from wa_messages', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('osint', 'OSINT mentions', 1, 'manual', 'High-confidence mentions from any enabled OSINT listener', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('heartbeat', 'Content signals', 1, 'hourly', 'The week''s strongest content signals from the OSINT heartbeat.', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('calendar', 'Calendar', 1, 'manual', 'Upcoming events in the next 7 days from calendar_events', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('email', 'Email', 0, 'manual', 'Placeholder · IMAP/Gmail listener lands later', unixepoch()*1000, unixepoch()*1000);

-- ── knowledge re-slug, operator edits preserved ──
-- from the editorial pack's interim slugs (the real handoff)
UPDATE knowledge_docs SET slug='plugin-digest-policy' WHERE slug='plugin-editorial-digest-policy' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-policy');
DELETE FROM knowledge_docs WHERE slug='plugin-editorial-digest-policy';
UPDATE knowledge_docs SET slug='plugin-digest-interests' WHERE slug='plugin-editorial-digest-interests' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-interests');
DELETE FROM knowledge_docs WHERE slug='plugin-editorial-digest-interests';
UPDATE knowledge_docs SET slug='plugin-digest-prompt-wa-reply' WHERE slug='plugin-editorial-prompt-wa-reply' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-prompt-wa-reply');
DELETE FROM knowledge_docs WHERE slug='plugin-editorial-prompt-wa-reply';
UPDATE knowledge_docs SET slug='plugin-digest-prompt-wa-delivery' WHERE slug='plugin-editorial-prompt-wa-delivery' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-prompt-wa-delivery');
DELETE FROM knowledge_docs WHERE slug='plugin-editorial-prompt-wa-delivery';
-- from raw legacy slugs (cmd-lineage installs; no-ops elsewhere)
UPDATE knowledge_docs SET slug='plugin-digest-policy' WHERE slug='digest-policy' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-policy');
DELETE FROM knowledge_docs WHERE slug='digest-policy';
UPDATE knowledge_docs SET slug='plugin-digest-interests' WHERE slug IN ('digest-interests', 'nyyon-digest-interests') AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-interests');
DELETE FROM knowledge_docs WHERE slug IN ('digest-interests', 'nyyon-digest-interests');
UPDATE knowledge_docs SET slug='plugin-digest-prompt-wa-reply' WHERE slug='prompt-wa-reply' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-prompt-wa-reply');
DELETE FROM knowledge_docs WHERE slug='prompt-wa-reply';
UPDATE knowledge_docs SET slug='plugin-digest-prompt-wa-delivery' WHERE slug='prompt-wa-delivery' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-prompt-wa-delivery');
DELETE FROM knowledge_docs WHERE slug='prompt-wa-delivery';
UPDATE knowledge_docs SET slug='plugin-digest-wa-send-slots' WHERE slug='wa-send-slots' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-wa-send-slots');
DELETE FROM knowledge_docs WHERE slug='wa-send-slots';
UPDATE knowledge_docs SET slug='plugin-digest-wa-pitches' WHERE slug='wa-pitches' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-wa-pitches');
DELETE FROM knowledge_docs WHERE slug='wa-pitches';
UPDATE knowledge_docs SET slug='plugin-digest-attention' WHERE slug='digest-attention' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-attention');
DELETE FROM knowledge_docs WHERE slug='digest-attention';
UPDATE knowledge_docs SET slug='plugin-digest-li-signals' WHERE slug='digest-li-signals' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-li-signals');
DELETE FROM knowledge_docs WHERE slug='digest-li-signals';
UPDATE knowledge_docs SET slug='plugin-digest-signal-priority' WHERE slug='signal-priority' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-signal-priority');
DELETE FROM knowledge_docs WHERE slug='signal-priority';
UPDATE knowledge_docs SET slug='plugin-digest-lead-heat' WHERE slug='lead-heat' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-lead-heat');
DELETE FROM knowledge_docs WHERE slug='lead-heat';
UPDATE knowledge_docs SET slug='plugin-digest-wa-draft-voice' WHERE slug='wa-draft-voice' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-digest-wa-draft-voice');
DELETE FROM knowledge_docs WHERE slug='wa-draft-voice';

-- Handoff from installs that ran editorial-with-digest (pre-1.1.0): copy the
-- INTERSECTING columns (shapes read from the real replayed schemas), then drop
-- editorial's digest tables. Guarded + re-runnable.
CREATE TABLE IF NOT EXISTS plugin_editorial_digest_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_kind TEXT, ref_id TEXT, title TEXT NOT NULL, summary TEXT, source_label TEXT, source_url TEXT, urgency INTEGER NOT NULL DEFAULT 2, actionable INTEGER NOT NULL DEFAULT 0, suggested_action TEXT, starred INTEGER NOT NULL DEFAULT 0, read_at INTEGER, created_at INTEGER NOT NULL, meta_json TEXT);
CREATE TABLE IF NOT EXISTS plugin_editorial_digest_channels (source TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'manual', notes TEXT, last_run_at INTEGER, last_status TEXT, last_error TEXT, total_runs INTEGER NOT NULL DEFAULT 0, total_added INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO plugin_digest_items (actionable, created_at, id, kind, meta_json, read_at, ref_id, ref_kind, source_label, source_url, starred, suggested_action, summary, title, urgency) SELECT actionable, created_at, id, kind, meta_json, read_at, ref_id, ref_kind, source_label, source_url, starred, suggested_action, summary, title, urgency FROM plugin_editorial_digest_items;
INSERT OR IGNORE INTO plugin_digest_channels (cadence, created_at, enabled, label, last_error, last_run_at, last_status, notes, source, total_added, total_runs, updated_at) SELECT cadence, created_at, enabled, label, last_error, last_run_at, last_status, notes, source, total_added, total_runs, updated_at FROM plugin_editorial_digest_channels;
DROP TABLE plugin_editorial_digest_items;
DROP TABLE plugin_editorial_digest_channels;
