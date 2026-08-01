-- Seed feature flags — default-on stance, every surface visible.
INSERT OR IGNORE INTO feature_flags (key, value, scope, description, updated_at) VALUES
  ('surface.knowledge', 1, 'surface', 'Knowledge module UI', strftime('%s','now') * 1000),
  ('surface.roadmap',   1, 'surface', 'Roadmap module UI',   strftime('%s','now') * 1000),
  ('surface.activity',  1, 'surface', 'Activity log UI',     strftime('%s','now') * 1000),
  ('surface.tools',     1, 'surface', 'Tools registry UI',   strftime('%s','now') * 1000),
  ('surface.nyo',       1, 'surface', 'Nyo chat drawer',     strftime('%s','now') * 1000);

-- Seed module registry — what Nyo knows about himself + neighbors.
INSERT OR IGNORE INTO modules (slug, name, status, description, surface, created_at, updated_at) VALUES
  ('nyo',       'Nyo',       'shipped', 'Chatbot at the center. Reads + writes knowledge, edits roadmap, calls every tool.', null,        strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('knowledge', 'Knowledge', 'shipped', 'Markdown docs Nyo reads + writes. System design as it actually lives.',              'knowledge', strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('roadmap',   'Roadmap',   'shipped', 'Relational nodes + edges describing what shipped and what is next.',                 'roadmap',   strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('activity',  'Activity',  'shipped', 'Append-only log of everything Nyo and the operator do.',                              'activity',  strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('website',   'Website',   'planned', 'Public marketing site with identity stitching + funnel. Same model as Inrepute.',     'website',   strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('blog',      'Blog',      'planned', 'Nyo writes posts. Knowledge + topic queue -> drafts -> publish.',                     'blog',      strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('ai-sdr',    'AI SDR',    'idea',    'Outbound sales pipeline. Campaigns, prospects, signals, drafts.',                     'ai-sdr',    strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('osint',     'OSINT',     'idea',    'Listens to Reddit, WhatsApp, other groups. Surfaces signals.',                        'osint',     strftime('%s','now') * 1000, strftime('%s','now') * 1000);

-- Seed tool registry — granular capabilities Nyo can compose.
INSERT OR IGNORE INTO tools (slug, name, kind, provider, status, description, config_key, created_at, updated_at) VALUES
  ('anthropic-text',  'Anthropic Messages',  'llm',       'anthropic',  'connected', 'Claude Opus 4.7 — the brain Nyo runs on. Also drives copywriting.', 'ANTHROPIC_API_KEY', strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('openai-image',    'OpenAI Image Gen',    'image',     'openai',     'planned',   'Image generation for blog, social, marketing assets.',              'OPENAI_API_KEY',    strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('remotion-video',  'Remotion',            'video',     'remotion',   'planned',   'Programmatic video editing.',                                       null,                strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('open-wa',         'open-wa.org',         'channel',   'open-wa',    'planned',   'WhatsApp monitoring + send for OSINT and outreach.',                null,                strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('reddit-listen',   'Reddit Listener',     'channel',   'reddit',     'planned',   'Subreddit + thread monitor feeding OSINT signals.',                 null,                strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('d1-relational',   'D1',                  'data',      'cloudflare', 'connected', 'Relational store: sessions, identities, conversions, knowledge, roadmap.', null,         strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('kv-fast',         'Workers KV',          'storage',   'cloudflare', 'planned',   'Fast key/value cache for hot lookups.',                             'KV',                strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('r2-bucket',       'R2',                  'storage',   'cloudflare', 'planned',   'Object storage for renders, exports, attachments.',                 'R2',                strftime('%s','now') * 1000, strftime('%s','now') * 1000);

-- Seed starter knowledge doc so Nyo has something to read on day one.
INSERT OR IGNORE INTO knowledge_docs (slug, title, body, scope, module, updated_at) VALUES
  ('about',
   'About Nyyon Command Center',
   '# Nyyon Command Center

Operator backstage hub. A chatbot called **Nyo** sits at the center, surrounded by **modules** (workflows like Website, Blog, AI SDR, OSINT) and **tools** (granular capabilities like Anthropic, OpenAI image gen, Remotion, open-wa, D1, KV, R2).

Modules use tools to do real work. Tools are the verbs; modules are the sentences. Nyo is the editor who knows about every verb and every sentence.

This doc is editable. Add positioning, system-design principles, north stars — anything you want Nyo to know before answering.',
   'global', NULL, strftime('%s','now') * 1000),

  ('how-knowledge-works',
   'How Knowledge Works',
   '# How Knowledge Works

Every doc here is read + written by Nyo. He uses ``list_knowledge`` to enumerate slugs, ``read_knowledge`` to load one, and ``write_knowledge`` to capture decisions.

**Scope rules**
- ``global`` — system-wide facts, principles, definitions.
- ``module`` — scoped to one module slug (e.g. blog, ai-sdr).

**Slug convention**: lowercase-with-dashes. Stable identifier, never rename — write a new doc and link instead.',
   'global', NULL, strftime('%s','now') * 1000),

  ('how-roadmap-works',
   'How the Roadmap Works',
   '# How the Roadmap Works

Roadmap is relational: **nodes** (a thing) + **edges** (how things relate). Statuses: ``shipped``, ``now``, ``next``, ``later``, ``idea``. Area is a free-form group, usually a module slug.

Nyo populates it via ``create_roadmap_node``, ``update_roadmap_node``, ``create_roadmap_edge``. The operator can ask "what is shipped" or "what depends on the blog" and Nyo reads the graph.',
   'global', NULL, strftime('%s','now') * 1000);

-- Seed first roadmap nodes — the modules themselves.
INSERT OR IGNORE INTO roadmap_nodes (id, title, description, status, area, x, y, shipped_at, created_at, updated_at) VALUES
  ('node_nyo',       'Nyo',       'Chatbot core. Tool-use loop on Claude Opus 4.7.',                   'shipped', 'nyo',       0,   0,   strftime('%s','now') * 1000, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('node_knowledge', 'Knowledge', 'Markdown docs Nyo reads + writes. Source of truth for system.',     'shipped', 'knowledge', 220, 0,   strftime('%s','now') * 1000, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('node_roadmap',   'Roadmap',   'Relational nodes + edges. This module describes itself.',           'shipped', 'roadmap',   440, 0,   strftime('%s','now') * 1000, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('node_activity',  'Activity',  'Append-only log of every event Nyo and operator generate.',         'shipped', 'activity',  660, 0,   strftime('%s','now') * 1000, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('node_website',   'Website',   'Public marketing site. Identity stitching + full funnel.',          'next',    'website',   0,   180, null,                        strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('node_blog',      'Blog',      'Nyo writes posts from knowledge + topic queue.',                    'next',    'blog',      220, 180, null,                        strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('node_aisdr',     'AI SDR',    'Outbound pipeline. Campaigns, prospects, signals, drafts.',         'later',   'ai-sdr',    440, 180, null,                        strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('node_osint',     'OSINT',     'Reddit + WhatsApp + group listener feeding signals.',               'later',   'osint',     660, 180, null,                        strftime('%s','now') * 1000, strftime('%s','now') * 1000);

INSERT OR IGNORE INTO roadmap_edges (id, source_id, target_id, kind, label, created_at) VALUES
  ('edge_blog_knowledge', 'node_blog',    'node_knowledge', 'depends_on', 'reads docs', strftime('%s','now') * 1000),
  ('edge_blog_website',   'node_blog',    'node_website',   'depends_on', 'publishes through site', strftime('%s','now') * 1000),
  ('edge_osint_aisdr',    'node_osint',   'node_aisdr',     'related',    'feeds signals',          strftime('%s','now') * 1000),
  ('edge_website_aisdr',  'node_website', 'node_aisdr',     'related',    'shares identities',      strftime('%s','now') * 1000);
