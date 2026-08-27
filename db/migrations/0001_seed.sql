-- Seed feature flags — default-on stance, every surface visible.
INSERT OR IGNORE INTO feature_flags (key, value, scope, description, updated_at) VALUES
  ('surface.knowledge', 1, 'surface', 'Knowledge module UI', strftime('%s','now') * 1000),
  ('surface.roadmap',   1, 'surface', 'Roadmap module UI',   strftime('%s','now') * 1000),
  ('surface.activity',  1, 'surface', 'Activity log UI',     strftime('%s','now') * 1000),
  ('surface.tools',     1, 'surface', 'Tools registry UI',   strftime('%s','now') * 1000),
  ('surface.nyo',       1, 'surface', 'Nyo chat drawer',     strftime('%s','now') * 1000);

-- Seed module registry — what Nyo knows about himself + neighbors.
-- (day-one modules/tools catalog rows removed — the live code registry replaced them)

-- Seed tool registry — granular capabilities Nyo can compose.

-- Seed starter knowledge doc so Nyo has something to read on day one.
INSERT OR IGNORE INTO knowledge_docs (slug, title, body, scope, module, updated_at) VALUES
  ('about',
   'About Nyyon Command Center',
   '# Nyyon Command Center

Operator backstage hub. A chatbot called **Nyo** sits at the center, surrounded by **modules** (workflows like Daily Planner, Prospecting, Outreach, Blog, Social, Hot Takes) and **tools** (granular capabilities in one shared pool — WhatsApp, LinkedIn, drafting, planning, publishing).

Modules use tools to do real work. Tools are the verbs; modules are the sentences. Nyo is the editor who knows about every verb and every sentence.

This doc is editable. Add positioning, system-design principles, north stars — anything you want Nyo to know before answering.',
   'global', NULL, strftime('%s','now') * 1000),

  ('how-knowledge-works',
   'How Knowledge Works',
   '# How Knowledge Works

Every doc here is read + written by Nyo. He uses ``list_knowledge`` to enumerate slugs, ``read_knowledge`` to load one, and ``write_knowledge`` to capture decisions.

**Scope rules**
- ``global`` — system-wide facts, principles, definitions.
- ``module`` — scoped to one module slug (e.g. blog, outreach).

**Slug convention**: lowercase-with-dashes. Stable identifier, never rename — write a new doc and link instead.',
   'global', NULL, strftime('%s','now') * 1000);


-- (roadmap seed removed — the roadmap surface is not part of the shipped product)
