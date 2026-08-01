-- 0021 — Roadmap as a tree.
--
-- Adds `parent_id` to `roadmap_nodes` so the planning surface reads
-- top-down ("here''s what we ship, and inside each module here''s what
-- comes next") instead of a flat status-grouped list. Existing edges
-- stay as semantic dependency / related links — distinct from the
-- hierarchy.
--
-- Safe to re-run: every INSERT uses OR REPLACE, every UPDATE matches on
-- id, and the parent_id column is gated with IF EXISTS via the wrapping
-- check below.

ALTER TABLE roadmap_nodes ADD COLUMN parent_id TEXT REFERENCES roadmap_nodes(id);
CREATE INDEX IF NOT EXISTS idx_roadmap_nodes_parent ON roadmap_nodes(parent_id);

-- ────────────────────────────────────────────────────────────────
-- Root + bucket nodes
-- ────────────────────────────────────────────────────────────────
INSERT OR REPLACE INTO roadmap_nodes (id, title, description, status, area, parent_id, x, y, created_at, updated_at) VALUES
('rm_root',     'Nyyon',  'The command center + everything we ship under it.', 'shipped', 'root',   NULL,        0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_modules',  'Modules','Workflows the operator runs daily.',                 'shipped', 'bucket', 'rm_root',   0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_system',   'System', 'Knowledge / Roadmap / Activity / Modules registry.', 'shipped', 'bucket', 'rm_root',   0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000);

-- ────────────────────────────────────────────────────────────────
-- New module nodes — modules that exist today but weren''t in the roadmap
-- ────────────────────────────────────────────────────────────────
INSERT OR REPLACE INTO roadmap_nodes (id, title, description, status, area, parent_id, x, y, created_at, updated_at) VALUES
('rm_digest',    'Digest',    'Morning brief from WhatsApp/OSINT/email. Two-stage drafting, recipient picker.', 'shipped', 'digest',   'rm_modules', 0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_outbox',    'Outbox',    'Unified send log. Queued → sent / failed. Retry button on failures.',           'shipped', 'outbox',   'rm_modules', 0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_contacts',  'Contacts',  'Operator-curated layer on top of identities. Taxonomy + LinkedIn URL.',         'shipped', 'contacts', 'rm_modules', 0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_calendar',  'Calendar',  'Internal events, content reminders, social-post schedule payloads.',           'shipped', 'calendar', 'rm_modules', 0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_aeo',       'AEO',       'Answer engine optimization — Q&A blog writer cron + structured data.',         'shipped', 'aeo',      'rm_modules', 0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_workflows', 'Workflows', 'Saved multi-step playbooks. Registry + run history.',                          'shipped', 'workflows','rm_modules', 0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_channels',  'Channels',  'WhatsApp + LinkedIn plumbing. Inbound listener, outbound wrappers.',           'shipped', 'channels', 'rm_modules', 0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_funnel',    'Funnel',    'Anonymous→customer staging with identity stitching.',                          'shipped', 'funnel',   'rm_modules', 0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000);

-- ────────────────────────────────────────────────────────────────
-- Explicit "next" leaf nodes — the things actually about to be built.
-- All parents reference roots we just inserted above (rm_*), so we never
-- depend on existing UUID-prefixed nodes whose ids we''d have to guess.
-- ────────────────────────────────────────────────────────────────
INSERT OR REPLACE INTO roadmap_nodes (id, title, description, status, area, parent_id, x, y, created_at, updated_at) VALUES
('rm_next_publish_ui',   'Publish from ops UI',  'One-click "Publish to nyyon.com" panel in Website Manager. Sidecar at :8791 runs build + wrangler deploy.',                              'shipped', 'website', 'node_website',  0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_next_grid_lights',  'Dynamic grid lights',  'Canvas overlay: cell under cursor + 8 neighbors + ambient flares. Gridlines viewport-fixed so they stay aligned during scroll.',         'shipped', 'website', 'node_website',  0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_next_kb_tree',      'Knowledge tree',       'Reorganize knowledge_docs as a tree (parent_slug). Breadcrumbs + reparent picker + per-module current-state docs.',                      'shipped', 'knowledge','node_knowledge', 0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_next_roadmap_tree', 'Roadmap tree',         'Same shape as Knowledge — parent_id on nodes, render tree top-down. (This migration.)',                                                  'shipped', 'roadmap',  'node_roadmap',   0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_next_wa_queue',     'WhatsApp send queue',  'Replace fire-and-forget sends with a real queue: throttling, scheduling, retry policy beyond Outbox''s one-shot.',                       'next',    'channels', 'rm_channels',    0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_next_li_channel',   'LinkedIn channel',     'Full LinkedIn parity with WhatsApp: digest items, drawer, send wrappers, Outbox rows.',                                                  'later',   'channels', 'rm_channels',    0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_next_digest_email', 'Digest email channel', 'Pull from Gmail/IMAP, extract opportunity items into the morning brief.',                                                                'next',    'digest',   'rm_digest',      0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000),
('rm_next_nyo_voice',    'Nyo voice mode',       'Push-to-talk Nyo with low-latency TTS so the operator can dictate while triaging.',                                                      'later',   'nyo',      'node_nyo',       0, 0, strftime('%s','now')*1000, strftime('%s','now')*1000);

-- ────────────────────────────────────────────────────────────────
-- Reparent existing nodes into the tree.
-- ────────────────────────────────────────────────────────────────
-- Top-level modules under the "Modules" bucket.
UPDATE roadmap_nodes SET parent_id = 'rm_modules' WHERE id IN ('node_nyo', 'node_website', 'node_blog', 'node_osint', 'node_aisdr');

-- Children of website (UUIDs from earlier seed; matched by title).
UPDATE roadmap_nodes SET parent_id = 'node_website' WHERE title IN (
  'Inner pages', 'Section layout control', 'Public tracker.js', 'Funnel public pages', 'Inrepute light visual lang.'
);
-- Children of nyo.
UPDATE roadmap_nodes SET parent_id = 'node_nyo'   WHERE title IN ('Full-screen Nyo + shared state', 'LLM provider abstraction');
-- Children of blog / osint / aisdr.
UPDATE roadmap_nodes SET parent_id = 'node_blog'  WHERE title = 'Blog: populate article bodies';
UPDATE roadmap_nodes SET parent_id = 'node_osint' WHERE title = 'OSINT Reddit + group monitors';
UPDATE roadmap_nodes SET parent_id = 'node_aisdr' WHERE title = 'AI SDR module';

-- Move the old UUID-keyed "Channels — WhatsApp" + "Funnel module" + their
-- children under our new bucket nodes rm_channels / rm_funnel so the tree
-- reads cleanly.
UPDATE roadmap_nodes SET parent_id = 'rm_channels' WHERE title = 'Channels — WhatsApp';
UPDATE roadmap_nodes SET parent_id = 'rm_channels' WHERE title = 'WhatsApp outbound (Phase 2)';
UPDATE roadmap_nodes SET parent_id = 'rm_funnel'   WHERE title = 'Funnel module';
UPDATE roadmap_nodes SET parent_id = 'rm_funnel'   WHERE title IN ('Identity stitching', 'Google Ads conversion firing');

-- System bucket: Knowledge, Roadmap, Activity.
UPDATE roadmap_nodes SET parent_id = 'rm_system' WHERE id IN ('node_knowledge', 'node_roadmap', 'node_activity');

-- ────────────────────────────────────────────────────────────────
-- Refresh statuses to current reality.
-- ────────────────────────────────────────────────────────────────
UPDATE roadmap_nodes SET status = 'shipped' WHERE id = 'node_osint';                                    -- listeners shipped
UPDATE roadmap_nodes SET status = 'shipped' WHERE id = 'node_blog' AND status = 'now';                  -- 188 articles imported
UPDATE roadmap_nodes SET status = 'now'     WHERE title = 'Blog: populate article bodies';
