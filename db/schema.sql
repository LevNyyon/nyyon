-- Nyyon Command Center — base D1 schema.
-- Apply locally:  npm run db:apply:local
-- Apply remote:   npm run db:apply:remote

-- ─── Nyo chat ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,           -- 'user' | 'assistant' | 'tool'
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_input TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created     ON messages(created_at);

-- ─── append-only activity log ────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,           -- 'knowledge_updated' | 'roadmap_node_added' | 'note' | 'module_added' | ...
  actor TEXT,                   -- 'system' | 'operator' | 'nyo'
  payload TEXT,                 -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_kind    ON events(kind);

-- ─── knowledge ───────────────────────────────────────────────
-- Markdown docs Nyo reads + writes for grounded answers.
-- Scope = global (system-wide) or module (scoped to one module).
CREATE TABLE IF NOT EXISTS knowledge_docs (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  module TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_scope  ON knowledge_docs(scope);
CREATE INDEX IF NOT EXISTS idx_knowledge_module ON knowledge_docs(module);

-- ─── feature flags ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  scope TEXT NOT NULL,           -- 'surface' | 'tool' | 'module'
  description TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feature_flags_scope ON feature_flags(scope);

-- ─── module + tool registry ──────────────────────────────────
-- Both surface in the sidebar and to Nyo so he knows his world.
CREATE TABLE IF NOT EXISTS modules (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idea', -- 'shipped' | 'building' | 'planned' | 'idea'
  description TEXT,
  surface TEXT,                  -- UI surface key, null if headless
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modules_status ON modules(status);

CREATE TABLE IF NOT EXISTS tools (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'llm' | 'image' | 'video' | 'data' | 'channel' | 'storage' | 'analytics'
  provider TEXT,                 -- 'anthropic' | 'openai' | 'remotion' | 'open-wa' | 'cloudflare' | ...
  status TEXT NOT NULL DEFAULT 'planned', -- 'connected' | 'planned' | 'broken'
  description TEXT,
  config_key TEXT,               -- name of secret/binding required
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tools_kind   ON tools(kind);
CREATE INDEX IF NOT EXISTS idx_tools_status ON tools(status);

-- ─── roadmap ─────────────────────────────────────────────────
-- Relational nodes + edges. Populated by Nyo or operator.
CREATE TABLE IF NOT EXISTS roadmap_nodes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'idea', -- 'shipped' | 'now' | 'next' | 'later' | 'idea'
  area TEXT,                            -- free-form group label (often module slug)
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  shipped_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roadmap_nodes_status ON roadmap_nodes(status);
CREATE INDEX IF NOT EXISTS idx_roadmap_nodes_area   ON roadmap_nodes(area);

CREATE TABLE IF NOT EXISTS roadmap_edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES roadmap_nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES roadmap_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'depends_on', -- 'depends_on' | 'blocks' | 'related'
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roadmap_edges_source ON roadmap_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_edges_target ON roadmap_edges(target_id);

-- ─── blog posts (article-level content, separate from content_blocks) ──────
CREATE TABLE IF NOT EXISTS blog_posts (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  excerpt TEXT,
  body TEXT,
  tags TEXT,                     -- JSON array
  published_at INTEGER,          -- ms epoch
  published INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at ON blog_posts(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published    ON blog_posts(published);

-- ─── home_sections — per-section visibility + ordering ──────
CREATE TABLE IF NOT EXISTS home_sections (
  id TEXT PRIMARY KEY,
  page TEXT NOT NULL DEFAULT 'home',
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_home_sections_page_pos ON home_sections(page, position);

-- ─── content blocks (editable website copy) ──────────────────
CREATE TABLE IF NOT EXISTS content_blocks (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',    -- 'text' | 'markdown' | 'html'
  page TEXT,
  section TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_content_blocks_page    ON content_blocks(page);
CREATE INDEX IF NOT EXISTS idx_content_blocks_section ON content_blocks(section);

-- ─── web / identity / conversions (placeholders for future modules) ─────────
-- These tables are reserved so OSINT, Website, and AI SDR modules can land
-- without further migration churn. They start empty.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cookie_id TEXT,
  person_id TEXT,
  ip TEXT,
  ua TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  gclid TEXT,
  gbraid TEXT,
  wbraid TEXT,
  fbclid TEXT,
  msclkid TEXT,
  ttclid TEXT,
  browser TEXT,
  os TEXT,
  device TEXT,
  referrer TEXT,
  landing_path TEXT,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_cookie  ON sessions(cookie_id);
CREATE INDEX IF NOT EXISTS idx_sessions_person  ON sessions(person_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_gclid   ON sessions(gclid);

-- ─── web_events — prospect tracking, distinct from ops `events` ───────
CREATE TABLE IF NOT EXISTS web_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  cookie_id  TEXT,
  person_id  TEXT,
  event_type TEXT NOT NULL,
  event_data TEXT,
  page_path  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_events_session ON web_events(session_id);
CREATE INDEX IF NOT EXISTS idx_web_events_cookie  ON web_events(cookie_id);
CREATE INDEX IF NOT EXISTS idx_web_events_person  ON web_events(person_id);
CREATE INDEX IF NOT EXISTS idx_web_events_type    ON web_events(event_type);
CREATE INDEX IF NOT EXISTS idx_web_events_created ON web_events(created_at DESC);

CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  cookie_id TEXT,
  email TEXT,
  phone TEXT,
  handle TEXT,                   -- reddit / wa / etc
  channel TEXT,                  -- 'web' | 'reddit' | 'whatsapp' | ...
  display_name TEXT,
  meta TEXT,                     -- JSON
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identities_email   ON identities(email);
CREATE INDEX IF NOT EXISTS idx_identities_cookie  ON identities(cookie_id);
CREATE INDEX IF NOT EXISTS idx_identities_handle  ON identities(handle);
CREATE INDEX IF NOT EXISTS idx_identities_channel ON identities(channel);

CREATE TABLE IF NOT EXISTS conversions (
  id TEXT PRIMARY KEY,
  identity_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,            -- 'signup' | 'lead' | 'sale' | 'demo' | ...
  value REAL,
  currency TEXT,
  source TEXT,
  payload TEXT,                  -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversions_identity ON conversions(identity_id);
CREATE INDEX IF NOT EXISTS idx_conversions_kind     ON conversions(kind);
CREATE INDEX IF NOT EXISTS idx_conversions_created  ON conversions(created_at);

-- ─── contacts — operator-curated layer on top of identities ────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  identity_id TEXT,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  company TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'prospect',
  source TEXT,
  owner TEXT,
  tags TEXT,
  notes TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_status     ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_owner      ON contacts(owner);
CREATE INDEX IF NOT EXISTS idx_contacts_source     ON contacts(source);
CREATE INDEX IF NOT EXISTS idx_contacts_starred    ON contacts(starred);
CREATE INDEX IF NOT EXISTS idx_contacts_email      ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_phone      ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_identity   ON contacts(identity_id);
CREATE INDEX IF NOT EXISTS idx_contacts_updated_at ON contacts(updated_at DESC);

-- ─── WhatsApp listener (shared OpenWA-compatible gateway, separate chats) ────────
CREATE TABLE IF NOT EXISTS wa_chats (
  id TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  auto_listen INTEGER NOT NULL DEFAULT 0,
  can_send INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  last_snippet TEXT,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_chats_auto_listen ON wa_chats(auto_listen);
CREATE INDEX IF NOT EXISTS idx_wa_chats_last_msg    ON wa_chats(last_message_at DESC);

CREATE TABLE IF NOT EXISTS wa_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  sender_id TEXT,
  sender_name TEXT,
  body TEXT,
  timestamp INTEGER NOT NULL,
  raw_json TEXT,
  person_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_chat      ON wa_messages(chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_person    ON wa_messages(person_id);
CREATE INDEX IF NOT EXISTS idx_wa_messages_timestamp ON wa_messages(timestamp DESC);

-- ─── identity_links — audit trail of every (cookie ↔ person ↔ identifier) ───
CREATE TABLE IF NOT EXISTS identity_links (
  id TEXT PRIMARY KEY,
  cookie_id        TEXT,
  person_id        TEXT NOT NULL,
  identifier_type  TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  method           TEXT,
  source_event_id  TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_links_cookie ON identity_links(cookie_id);
CREATE INDEX IF NOT EXISTS idx_identity_links_person ON identity_links(person_id);
CREATE INDEX IF NOT EXISTS idx_identity_links_value  ON identity_links(identifier_value);
CREATE INDEX IF NOT EXISTS idx_identity_links_type   ON identity_links(identifier_type);
