-- Editorial (Hot Takes + Blog/AEO + Social) becomes ONE plugin. Guarded copy
-- per table: legacy DDL is replayed at its FINAL shape (schema.sql + every
-- ALTER up to 0073) so the explicit column lists line up on fresh AND lived-in
-- installs, and the whole file is re-runnable. Every copy happens BEFORE any
-- drop: with foreign_keys ON (D1 default), dropping a parent table performs an
-- implicit DELETE whose ON DELETE SET NULL/CASCADE actions would mangle the
-- not-yet-copied legacy children (osint_signals.source_id, mentions, suggestions).

CREATE TABLE IF NOT EXISTS osint_sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, theme TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_fetched_at INTEGER, last_status TEXT, last_error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_editorial_osint_sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, theme TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_fetched_at INTEGER, last_status TEXT, last_error TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_osint_sources_enabled ON plugin_editorial_osint_sources (enabled);
INSERT OR IGNORE INTO plugin_editorial_osint_sources (id, kind, name, url, theme, enabled, last_fetched_at, last_status, last_error, created_at) SELECT id, kind, name, url, theme, enabled, last_fetched_at, last_status, last_error, created_at FROM osint_sources;

CREATE TABLE IF NOT EXISTS osint_signals (id TEXT PRIMARY KEY, source_id TEXT REFERENCES osint_sources(id) ON DELETE SET NULL, source_name TEXT, theme TEXT, title TEXT NOT NULL, url TEXT NOT NULL UNIQUE, summary TEXT, published_at INTEGER, relevance INTEGER, why TEXT, content_score INTEGER, formats TEXT, suggested_angle TEXT, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL, full_text TEXT, content_fetched_at INTEGER);
CREATE TABLE IF NOT EXISTS plugin_editorial_osint_signals (id TEXT PRIMARY KEY, source_id TEXT REFERENCES plugin_editorial_osint_sources(id) ON DELETE SET NULL, source_name TEXT, theme TEXT, title TEXT NOT NULL, url TEXT NOT NULL UNIQUE, summary TEXT, published_at INTEGER, relevance INTEGER, why TEXT, content_score INTEGER, formats TEXT, suggested_angle TEXT, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL, full_text TEXT, content_fetched_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_osint_signals_status ON plugin_editorial_osint_signals (status);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_osint_signals_published_at ON plugin_editorial_osint_signals (published_at DESC);
INSERT OR IGNORE INTO plugin_editorial_osint_signals (id, source_id, source_name, theme, title, url, summary, published_at, relevance, why, content_score, formats, suggested_angle, status, created_at, full_text, content_fetched_at) SELECT id, source_id, source_name, theme, title, url, summary, published_at, relevance, why, content_score, formats, suggested_angle, status, created_at, full_text, content_fetched_at FROM osint_signals;

CREATE TABLE IF NOT EXISTS osint_topics (id TEXT PRIMARY KEY, title TEXT NOT NULL, thesis TEXT, why_now TEXT, angle TEXT, format TEXT, heat INTEGER, sources_json TEXT, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_editorial_osint_topics (id TEXT PRIMARY KEY, title TEXT NOT NULL, thesis TEXT, why_now TEXT, angle TEXT, format TEXT, heat INTEGER, sources_json TEXT, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_osint_topics_heat ON plugin_editorial_osint_topics (heat DESC);
INSERT OR IGNORE INTO plugin_editorial_osint_topics (id, title, thesis, why_now, angle, format, heat, sources_json, status, created_at) SELECT id, title, thesis, why_now, angle, format, heat, sources_json, status, created_at FROM osint_topics;

CREATE TABLE IF NOT EXISTS osint_targets (id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT, app_id TEXT, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT, updated_by TEXT);
CREATE TABLE IF NOT EXISTS plugin_editorial_osint_targets (id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT, app_id TEXT, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT, updated_by TEXT);
INSERT OR IGNORE INTO plugin_editorial_osint_targets (id, name, domain, app_id, notes, created_at, updated_at, created_by, updated_by) SELECT id, name, domain, app_id, notes, created_at, updated_at, created_by, updated_by FROM osint_targets;

CREATE TABLE IF NOT EXISTS osint_mentions (id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES osint_targets(id) ON DELETE CASCADE, source TEXT NOT NULL, source_url TEXT, reviewer TEXT, rating INTEGER, text TEXT NOT NULL, posted_at INTEGER, confidence REAL, kind TEXT NOT NULL DEFAULT 'mention', raw_json TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_editorial_osint_mentions (id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES plugin_editorial_osint_targets(id) ON DELETE CASCADE, source TEXT NOT NULL, source_url TEXT, reviewer TEXT, rating INTEGER, text TEXT NOT NULL, posted_at INTEGER, confidence REAL, kind TEXT NOT NULL DEFAULT 'mention', raw_json TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_osint_mentions_target_id ON plugin_editorial_osint_mentions (target_id);
INSERT OR IGNORE INTO plugin_editorial_osint_mentions (id, target_id, source, source_url, reviewer, rating, text, posted_at, confidence, kind, raw_json, created_at) SELECT id, target_id, source, source_url, reviewer, rating, text, posted_at, confidence, kind, raw_json, created_at FROM osint_mentions;

CREATE TABLE IF NOT EXISTS osint_listeners (source TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'manual', notes TEXT, last_run_at INTEGER, last_status TEXT, last_error TEXT, total_runs INTEGER NOT NULL DEFAULT 0, total_added INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_editorial_osint_listeners (source TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'manual', notes TEXT, last_run_at INTEGER, last_status TEXT, last_error TEXT, total_runs INTEGER NOT NULL DEFAULT 0, total_added INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO plugin_editorial_osint_listeners (source, label, enabled, cadence, notes, last_run_at, last_status, last_error, total_runs, total_added, created_at, updated_at) SELECT source, label, enabled, cadence, notes, last_run_at, last_status, last_error, total_runs, total_added, created_at, updated_at FROM osint_listeners;

CREATE TABLE IF NOT EXISTS digest_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_kind TEXT, ref_id TEXT, title TEXT NOT NULL, summary TEXT, source_label TEXT, source_url TEXT, urgency INTEGER NOT NULL DEFAULT 2, actionable INTEGER NOT NULL DEFAULT 0, suggested_action TEXT, starred INTEGER NOT NULL DEFAULT 0, read_at INTEGER, created_at INTEGER NOT NULL, meta_json TEXT);
CREATE TABLE IF NOT EXISTS plugin_editorial_digest_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_kind TEXT, ref_id TEXT, title TEXT NOT NULL, summary TEXT, source_label TEXT, source_url TEXT, urgency INTEGER NOT NULL DEFAULT 2, actionable INTEGER NOT NULL DEFAULT 0, suggested_action TEXT, starred INTEGER NOT NULL DEFAULT 0, read_at INTEGER, created_at INTEGER NOT NULL, meta_json TEXT);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_digest_items_created_at ON plugin_editorial_digest_items (created_at);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_digest_items_read_at ON plugin_editorial_digest_items (read_at);
INSERT OR IGNORE INTO plugin_editorial_digest_items (id, kind, ref_kind, ref_id, title, summary, source_label, source_url, urgency, actionable, suggested_action, starred, read_at, created_at, meta_json) SELECT id, kind, ref_kind, ref_id, title, summary, source_label, source_url, urgency, actionable, suggested_action, starred, read_at, created_at, meta_json FROM digest_items;

CREATE TABLE IF NOT EXISTS digest_channels (source TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'manual', notes TEXT, last_run_at INTEGER, last_status TEXT, last_error TEXT, total_runs INTEGER NOT NULL DEFAULT 0, total_added INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_editorial_digest_channels (source TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, cadence TEXT NOT NULL DEFAULT 'manual', notes TEXT, last_run_at INTEGER, last_status TEXT, last_error TEXT, total_runs INTEGER NOT NULL DEFAULT 0, total_added INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO plugin_editorial_digest_channels (source, label, enabled, cadence, notes, last_run_at, last_status, last_error, total_runs, total_added, created_at, updated_at) SELECT source, label, enabled, cadence, notes, last_run_at, last_status, last_error, total_runs, total_added, created_at, updated_at FROM digest_channels;

CREATE TABLE IF NOT EXISTS blog_posts (slug TEXT PRIMARY KEY, title TEXT NOT NULL, excerpt TEXT, body TEXT, tags TEXT, published_at INTEGER, published INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT, featured_image_url TEXT, featured_image_prompt TEXT, featured_image_model TEXT, featured_image_generated_at INTEGER);
CREATE TABLE IF NOT EXISTS plugin_editorial_blog_posts (slug TEXT PRIMARY KEY, title TEXT NOT NULL, excerpt TEXT, body TEXT, tags TEXT, published_at INTEGER, published INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT, featured_image_url TEXT, featured_image_prompt TEXT, featured_image_model TEXT, featured_image_generated_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_blog_posts_published_at ON plugin_editorial_blog_posts (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_blog_posts_published ON plugin_editorial_blog_posts (published);
INSERT OR IGNORE INTO plugin_editorial_blog_posts (slug, title, excerpt, body, tags, published_at, published, updated_at, updated_by, featured_image_url, featured_image_prompt, featured_image_model, featured_image_generated_at) SELECT slug, title, excerpt, body, tags, published_at, published, updated_at, updated_by, featured_image_url, featured_image_prompt, featured_image_model, featured_image_generated_at FROM blog_posts;

CREATE TABLE IF NOT EXISTS aeo_questions (slug TEXT PRIMARY KEY, question TEXT NOT NULL, target_keyword TEXT, priority INTEGER NOT NULL DEFAULT 5, status TEXT NOT NULL DEFAULT 'pending', scheduled_for INTEGER, drafted_blog_slug TEXT, last_error TEXT, attempts INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expert_context_json TEXT, interview_status TEXT, voice TEXT NOT NULL DEFAULT 'house');
CREATE TABLE IF NOT EXISTS plugin_editorial_aeo_questions (slug TEXT PRIMARY KEY, question TEXT NOT NULL, target_keyword TEXT, priority INTEGER NOT NULL DEFAULT 5, status TEXT NOT NULL DEFAULT 'pending', scheduled_for INTEGER, drafted_blog_slug TEXT, last_error TEXT, attempts INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expert_context_json TEXT, interview_status TEXT, voice TEXT NOT NULL DEFAULT 'house');
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_aeo_questions_status ON plugin_editorial_aeo_questions (status);
INSERT OR IGNORE INTO plugin_editorial_aeo_questions (slug, question, target_keyword, priority, status, scheduled_for, drafted_blog_slug, last_error, attempts, notes, created_at, updated_at, expert_context_json, interview_status, voice) SELECT slug, question, target_keyword, priority, status, scheduled_for, drafted_blog_slug, last_error, attempts, notes, created_at, updated_at, expert_context_json, interview_status, voice FROM aeo_questions;

CREATE TABLE IF NOT EXISTS aeo_suggestions (id TEXT PRIMARY KEY, signal_id TEXT REFERENCES osint_signals(id) ON DELETE SET NULL, title TEXT NOT NULL, angle TEXT NOT NULL, rationale TEXT, target_keyword TEXT, source_name TEXT, source_url TEXT, status TEXT NOT NULL DEFAULT 'pending', question_slug TEXT, last_error TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT);
CREATE TABLE IF NOT EXISTS plugin_editorial_aeo_suggestions (id TEXT PRIMARY KEY, signal_id TEXT REFERENCES plugin_editorial_osint_signals(id) ON DELETE SET NULL, title TEXT NOT NULL, angle TEXT NOT NULL, rationale TEXT, target_keyword TEXT, source_name TEXT, source_url TEXT, status TEXT NOT NULL DEFAULT 'pending', question_slug TEXT, last_error TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_aeo_suggestions_status ON plugin_editorial_aeo_suggestions (status);
INSERT OR IGNORE INTO plugin_editorial_aeo_suggestions (id, signal_id, title, angle, rationale, target_keyword, source_name, source_url, status, question_slug, last_error, created_at, decided_at, decided_by) SELECT id, signal_id, title, angle, rationale, target_keyword, source_name, source_url, status, question_slug, last_error, created_at, decided_at, decided_by FROM aeo_suggestions;

CREATE TABLE IF NOT EXISTS aeo_feedback (id TEXT PRIMARY KEY, question_slug TEXT, idea_title TEXT, reaction TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_editorial_aeo_feedback (id TEXT PRIMARY KEY, question_slug TEXT, idea_title TEXT, reaction TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_aeo_feedback_question_slug ON plugin_editorial_aeo_feedback (question_slug);
INSERT OR IGNORE INTO plugin_editorial_aeo_feedback (id, question_slug, idea_title, reaction, note, created_at) SELECT id, question_slug, idea_title, reaction, note, created_at FROM aeo_feedback;

CREATE TABLE IF NOT EXISTS brain_sessions (id TEXT PRIMARY KEY, week_of INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', questions_json TEXT, answers_text TEXT, derived_json TEXT, created_at INTEGER NOT NULL, completed_at INTEGER);
CREATE TABLE IF NOT EXISTS plugin_editorial_brain_sessions (id TEXT PRIMARY KEY, week_of INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', questions_json TEXT, answers_text TEXT, derived_json TEXT, created_at INTEGER NOT NULL, completed_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_brain_sessions_week_of ON plugin_editorial_brain_sessions (week_of DESC);
INSERT OR IGNORE INTO plugin_editorial_brain_sessions (id, week_of, status, questions_json, answers_text, derived_json, created_at, completed_at) SELECT id, week_of, status, questions_json, answers_text, derived_json, created_at, completed_at FROM brain_sessions;

CREATE TABLE IF NOT EXISTS hot_take_packages (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'topic', title TEXT, summary TEXT, why_it_matters TEXT, source_name TEXT, source_url TEXT, published_at INTEGER, origin TEXT, origin_ref TEXT, multi_source_json TEXT, pinned INTEGER NOT NULL DEFAULT 0, take TEXT, believe TEXT, misunderstood TEXT, who_cares TEXT, reader_action TEXT, brief_json TEXT, blog_slug TEXT, headline TEXT, intro TEXT, review_json TEXT, company_notes TEXT, author_notes TEXT, website_status TEXT NOT NULL DEFAULT 'not_planned', website_url TEXT, scheduled_at INTEGER, actor TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_editorial_hot_take_packages (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'topic', title TEXT, summary TEXT, why_it_matters TEXT, source_name TEXT, source_url TEXT, published_at INTEGER, origin TEXT, origin_ref TEXT, multi_source_json TEXT, pinned INTEGER NOT NULL DEFAULT 0, take TEXT, believe TEXT, misunderstood TEXT, who_cares TEXT, reader_action TEXT, brief_json TEXT, blog_slug TEXT, headline TEXT, intro TEXT, review_json TEXT, company_notes TEXT, author_notes TEXT, website_status TEXT NOT NULL DEFAULT 'not_planned', website_url TEXT, scheduled_at INTEGER, actor TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_hot_take_packages_status ON plugin_editorial_hot_take_packages (status);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_hot_take_packages_updated_at ON plugin_editorial_hot_take_packages (updated_at);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_hot_take_packages_origin_ref ON plugin_editorial_hot_take_packages (origin_ref);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_hot_take_packages_blog_slug ON plugin_editorial_hot_take_packages (blog_slug);
INSERT OR IGNORE INTO plugin_editorial_hot_take_packages (id, status, title, summary, why_it_matters, source_name, source_url, published_at, origin, origin_ref, multi_source_json, pinned, take, believe, misunderstood, who_cares, reader_action, brief_json, blog_slug, headline, intro, review_json, company_notes, author_notes, website_status, website_url, scheduled_at, actor, created_at, updated_at) SELECT id, status, title, summary, why_it_matters, source_name, source_url, published_at, origin, origin_ref, multi_source_json, pinned, take, believe, misunderstood, who_cares, reader_action, brief_json, blog_slug, headline, intro, review_json, company_notes, author_notes, website_status, website_url, scheduled_at, actor, created_at, updated_at FROM hot_take_packages;

CREATE TABLE IF NOT EXISTS social_posts (id TEXT PRIMARY KEY, blog_slug TEXT, package_id TEXT, channel TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', content TEXT NOT NULL DEFAULT '', notes TEXT, image_url TEXT, error TEXT, outbox_id TEXT, scheduled_at INTEGER, posted_at INTEGER, actor TEXT, blog_title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_editorial_social_posts (id TEXT PRIMARY KEY, blog_slug TEXT, package_id TEXT, channel TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', content TEXT NOT NULL DEFAULT '', notes TEXT, image_url TEXT, error TEXT, outbox_id TEXT, scheduled_at INTEGER, posted_at INTEGER, actor TEXT, blog_title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_social_posts_blog_slug ON plugin_editorial_social_posts (blog_slug);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_social_posts_status ON plugin_editorial_social_posts (status);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_social_posts_package_id ON plugin_editorial_social_posts (package_id);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_social_posts_scheduled_at ON plugin_editorial_social_posts (scheduled_at);
INSERT OR IGNORE INTO plugin_editorial_social_posts (id, blog_slug, package_id, channel, status, content, notes, image_url, error, outbox_id, scheduled_at, posted_at, actor, blog_title, created_at, updated_at) SELECT id, blog_slug, package_id, channel, status, content, notes, image_url, error, outbox_id, scheduled_at, posted_at, actor, blog_title, created_at, updated_at FROM social_posts;

CREATE TABLE IF NOT EXISTS social_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, template TEXT NOT NULL, url TEXT NOT NULL, r2_key TEXT NOT NULL, slots_json TEXT, width INTEGER, height INTEGER, actor TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_editorial_social_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, template TEXT NOT NULL, url TEXT NOT NULL, r2_key TEXT NOT NULL, slots_json TEXT, width INTEGER, height INTEGER, actor TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_plugin_editorial_social_cards_slug ON plugin_editorial_social_cards (slug);
INSERT OR IGNORE INTO plugin_editorial_social_cards (id, slug, template, url, r2_key, slots_json, width, height, actor, created_at) SELECT id, slug, template, url, r2_key, slots_json, width, height, actor, created_at FROM social_cards;

-- Drops last, children before parents, so no FK action ever fires into a
-- table that still holds uncopied rows.
DROP TABLE osint_mentions;
DROP TABLE aeo_suggestions;
DROP TABLE osint_signals;
DROP TABLE osint_sources;
DROP TABLE osint_targets;
DROP TABLE osint_topics;
DROP TABLE osint_listeners;
DROP TABLE digest_items;
DROP TABLE digest_channels;
DROP TABLE blog_posts;
DROP TABLE aeo_questions;
DROP TABLE aeo_feedback;
DROP TABLE brain_sessions;
DROP TABLE hot_take_packages;
DROP TABLE social_posts;
DROP TABLE social_cards;

-- Fresh installs never ran the 0014/0016 seed inserts against the legacy
-- tables, so re-seed the listener/channel registries into the plugin tables.
-- OR IGNORE keeps migrated rows (operator state) untouched.
INSERT OR IGNORE INTO plugin_editorial_osint_listeners (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('hn', 'Hacker News', 1, 'manual', 'Algolia search · keyless', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_editorial_osint_listeners (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('reddit', 'Reddit', 1, 'manual', 'public search.json · keyless · throttled 2.2s', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_editorial_osint_listeners (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('duckduckgo', 'DuckDuckGo (web)', 1, 'manual', 'html.duckduckgo.com · keyless · throttled 3.5s', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_editorial_osint_listeners (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('stackoverflow', 'Stack Overflow', 0, 'manual', 'StackExchange search/excerpts API', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_editorial_osint_listeners (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('github', 'GitHub Issues', 0, 'manual', 'keyless public rate limit', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_editorial_osint_listeners (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('appstore', 'Apple App Store', 0, 'manual', 'RSS · needs target.app_id', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_editorial_osint_listeners (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('website', 'Owned-site testimonials', 0, 'manual', 'probes /reviews, /testimonials, etc.', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_editorial_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('whatsapp', 'WhatsApp (OpenWA)', 1, 'manual', 'Inbound group + DM messages from wa_messages', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_editorial_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('calendar', 'Calendar', 1, 'manual', 'Upcoming events in the next 24h from calendar_events', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_editorial_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('osint', 'OSINT mentions', 1, 'manual', 'High-confidence mentions from any enabled OSINT listener', unixepoch()*1000, unixepoch()*1000);
INSERT OR IGNORE INTO plugin_editorial_digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES ('email', 'Email', 0, 'manual', 'Placeholder · IMAP/Gmail listener lands later', unixepoch()*1000, unixepoch()*1000);

-- Knowledge moves into the plugin namespace, operator edits preserved.
UPDATE knowledge_docs SET slug='plugin-editorial-hottakes-link-extract' WHERE slug='hottakes-link-extract' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-hottakes-link-extract');
DELETE FROM knowledge_docs WHERE slug='hottakes-link-extract';
UPDATE knowledge_docs SET slug='plugin-editorial-hottakes-pov-library' WHERE slug='hottakes-pov-library' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-hottakes-pov-library');
DELETE FROM knowledge_docs WHERE slug='hottakes-pov-library';
UPDATE knowledge_docs SET slug='plugin-editorial-hottakes-article-patterns' WHERE slug='hottakes-article-patterns' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-hottakes-article-patterns');
DELETE FROM knowledge_docs WHERE slug='hottakes-article-patterns';
UPDATE knowledge_docs SET slug='plugin-editorial-hottakes-quality-rules' WHERE slug='hottakes-quality-rules' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-hottakes-quality-rules');
DELETE FROM knowledge_docs WHERE slug='hottakes-quality-rules';
UPDATE knowledge_docs SET slug='plugin-editorial-hottakes-playbook' WHERE slug='hottakes-playbook' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-hottakes-playbook');
DELETE FROM knowledge_docs WHERE slug='hottakes-playbook';
UPDATE knowledge_docs SET slug='plugin-editorial-hottakes-timing' WHERE slug='hottakes-timing' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-hottakes-timing');
DELETE FROM knowledge_docs WHERE slug='hottakes-timing';
UPDATE knowledge_docs SET slug='plugin-editorial-hottakes-social-identities' WHERE slug='hottakes-social-identities' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-hottakes-social-identities');
DELETE FROM knowledge_docs WHERE slug='hottakes-social-identities';
UPDATE knowledge_docs SET slug='plugin-editorial-hottakes-source-scout' WHERE slug='hottakes-source-scout' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-hottakes-source-scout');
DELETE FROM knowledge_docs WHERE slug='hottakes-source-scout';
UPDATE knowledge_docs SET slug='plugin-editorial-heartbeat-priorities' WHERE slug='heartbeat-priorities' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-heartbeat-priorities');
DELETE FROM knowledge_docs WHERE slug='heartbeat-priorities';
UPDATE knowledge_docs SET slug='plugin-editorial-heartbeat-pulse-prompt' WHERE slug='heartbeat-pulse-prompt' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-heartbeat-pulse-prompt');
DELETE FROM knowledge_docs WHERE slug='heartbeat-pulse-prompt';
UPDATE knowledge_docs SET slug='plugin-editorial-industry-pulse' WHERE slug='industry-pulse' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-industry-pulse');
DELETE FROM knowledge_docs WHERE slug='industry-pulse';
UPDATE knowledge_docs SET slug='plugin-editorial-editorial-taste' WHERE slug='editorial-taste' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-editorial-taste');
DELETE FROM knowledge_docs WHERE slug='editorial-taste';
UPDATE knowledge_docs SET slug='plugin-editorial-digest-policy' WHERE slug='digest-policy' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-digest-policy');
DELETE FROM knowledge_docs WHERE slug='digest-policy';
UPDATE knowledge_docs SET slug='plugin-editorial-digest-interests' WHERE slug='digest-interests' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-digest-interests');
DELETE FROM knowledge_docs WHERE slug='digest-interests';
UPDATE knowledge_docs SET slug='plugin-editorial-prompt-wa-reply' WHERE slug='prompt-wa-reply' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-prompt-wa-reply');
DELETE FROM knowledge_docs WHERE slug='prompt-wa-reply';
UPDATE knowledge_docs SET slug='plugin-editorial-prompt-wa-delivery' WHERE slug='prompt-wa-delivery' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-prompt-wa-delivery');
DELETE FROM knowledge_docs WHERE slug='prompt-wa-delivery';
UPDATE knowledge_docs SET slug='plugin-editorial-aeo-suggestion-policy' WHERE slug='aeo-suggestion-policy' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-aeo-suggestion-policy');
DELETE FROM knowledge_docs WHERE slug='aeo-suggestion-policy';
UPDATE knowledge_docs SET slug='plugin-editorial-figure-chart-selection' WHERE slug='figure-chart-selection' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-figure-chart-selection');
DELETE FROM knowledge_docs WHERE slug='figure-chart-selection';
UPDATE knowledge_docs SET slug='plugin-editorial-visual-style' WHERE slug='visual-style' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-visual-style');
DELETE FROM knowledge_docs WHERE slug='visual-style';
UPDATE knowledge_docs SET slug='plugin-editorial-brain-archive' WHERE slug='brain-archive' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-brain-archive');
DELETE FROM knowledge_docs WHERE slug='brain-archive';
-- Weekly brain archives are date-stamped instances of the same rename.
UPDATE OR IGNORE knowledge_docs SET slug='plugin-editorial-' || slug WHERE slug LIKE 'brain-____-__-__';
DELETE FROM knowledge_docs WHERE slug LIKE 'brain-____-__-__';

-- The hottakes first-run receipt keys move from 'hot-takes' to 'hottakes'
-- (the plugin setup gateway uses the module key without the dash).
UPDATE module_setup SET module='hottakes' WHERE module='hot-takes' AND NOT EXISTS (SELECT 1 FROM module_setup WHERE module='hottakes');
DELETE FROM module_setup WHERE module='hot-takes';

-- The host-seeded copies of the workflows now shipped BY the plugin: their
-- seed files are deleted, so the rows are orphans blocking the plugin slugs.
-- Keyed on source='system', NOT created_by: writeWorkflow stamps an operator/
-- Nyo edit as source='nyo' while leaving created_by='system', so a customized
-- row must survive (operator edits always win; the runner's seeding applies
-- the same discriminator).
DELETE FROM workflows WHERE slug='blog-shape' AND source='system';
DELETE FROM workflows WHERE slug='blog-expand' AND source='system';
DELETE FROM workflows WHERE slug='article-figures' AND source='system';
DELETE FROM workflows WHERE slug='blog-cover' AND source='system';
DELETE FROM workflows WHERE slug='blog-featured-image' AND source='system';
DELETE FROM workflows WHERE slug='social-card' AND source='system';
DELETE FROM workflows WHERE slug='article-from-social' AND source='system';
DELETE FROM workflows WHERE slug='aeo-interview-start' AND source='system';
DELETE FROM workflows WHERE slug='aeo-write' AND source='system';
DELETE FROM workflows WHERE slug='aeo-write-with-answers' AND source='system';
DELETE FROM workflows WHERE slug='aeo-react' AND source='system';
DELETE FROM workflows WHERE slug='aeo-suggestion-generator' AND source='system';
DELETE FROM workflows WHERE slug='social-drafts-for-article' AND source='system';
DELETE FROM workflows WHERE slug='social-release-post' AND source='system';
DELETE FROM workflows WHERE slug='social-post-now' AND source='system';
DELETE FROM workflows WHERE slug='hottake-add-link' AND source='system';
DELETE FROM workflows WHERE slug='hottake-produce' AND source='system';
DELETE FROM workflows WHERE slug='hourly-awareness-sweep' AND source='system';
DELETE FROM workflows WHERE slug='hottakes-first-ingest' AND source='system';
DELETE FROM workflows WHERE slug='signal-to-blog' AND source='system';

-- Knowledge-tree hygiene after the module-to-plugin conversions: host docs the
-- packs read re-parent to the root; the emptied module-* tree nodes and the
-- superseded cadence doc (zero readers) go away. module-nyo stays — Nyo is
-- the host.
UPDATE knowledge_docs SET parent_slug = 'knowledge-root' WHERE slug IN ('article-playbook', 'kpi-outreach');
DELETE FROM knowledge_docs WHERE slug = 'outreach-queue-cadence';
-- knowledge_docs.parent_slug is a SELF-referencing foreign key, so a node
-- cannot be deleted while ANY doc still points at it. Re-home every child
-- first (the two named docs above are the ones we keep on purpose; this
-- catches everything else on any install), then drop the emptied nodes.
UPDATE knowledge_docs SET parent_slug = 'knowledge-root'
WHERE parent_slug IN ('module-aeo','module-blog','module-calendar','module-channels','module-digest','module-gtm','module-hot-takes','module-osint','module-outbox','module-outreach','module-workflows');
DELETE FROM knowledge_docs WHERE slug IN ('module-aeo','module-blog','module-calendar','module-channels','module-digest','module-gtm','module-hot-takes','module-osint','module-outbox','module-outreach','module-workflows');
