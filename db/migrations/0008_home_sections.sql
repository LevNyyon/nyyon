-- 0008 — home_sections: per-section visibility + ordering for the public site.
-- One row per section (hero, services, …). Public site reads this to decide
-- what renders and in what order. Operator edits from ops Website → Manager.

CREATE TABLE IF NOT EXISTS home_sections (
  id TEXT PRIMARY KEY,          -- section key: 'hero' | 'promise' | 'thesis' | 'domains' | 'toolbox' | 'how-we-work' | 'process' | 'faq' | 'cta'
  page TEXT NOT NULL DEFAULT 'home',
  label TEXT NOT NULL,
  position INTEGER NOT NULL,    -- ascending render order
  visible INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_home_sections_page_pos ON home_sections(page, position);

-- Canonical live section set. Must mirror web-public/src/lib/sections.ts FALLBACK_SECTIONS
-- and the SECTION_MAP in web-public/src/pages/Home.tsx.
INSERT OR IGNORE INTO home_sections (id, page, label, position, visible, updated_at, updated_by) VALUES
  ('hero',        'home', 'Hero',                  10, 1, strftime('%s','now') * 1000, 'system'),
  ('promise',     'home', 'Promise strip',         20, 1, strftime('%s','now') * 1000, 'system'),
  ('thesis',      'home', 'Thesis',                25, 1, strftime('%s','now') * 1000, 'system'),
  ('domains',     'home', 'Domains',               27, 1, strftime('%s','now') * 1000, 'system'),
  ('toolbox',     'home', 'Toolbox',               29, 1, strftime('%s','now') * 1000, 'system'),
  ('how-we-work', 'home', 'Working with Nyyon',    32, 1, strftime('%s','now') * 1000, 'system'),
  ('process',     'home', 'Engagement Structures', 36, 1, strftime('%s','now') * 1000, 'system'),
  ('cta',         'home', 'Final CTA',             80, 1, strftime('%s','now') * 1000, 'system'),
  ('faq',         'home', 'FAQ',                   85, 1, strftime('%s','now') * 1000, 'system');
