-- 0002 — content_blocks for the Website module.
-- Slug-keyed copy blocks the public marketing site reads + the ops UI edits.

CREATE TABLE IF NOT EXISTS content_blocks (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',    -- 'text' | 'markdown' | 'html'
  page TEXT,                            -- e.g. 'home' | 'login' | 'meta'
  section TEXT,                         -- 'hero' | 'services' | 'process' | ...
  updated_at INTEGER NOT NULL,
  updated_by TEXT,                      -- 'system' | 'operator' | 'nyo'
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_content_blocks_page    ON content_blocks(page);
CREATE INDEX IF NOT EXISTS idx_content_blocks_section ON content_blocks(section);

-- ─── seed (all home page) ─────────────────────────────────────
-- Slug convention: home.<section>.<field>   or   home.<section>.<NN>.<field>
-- Section ordering is enforced by Website.tsx, not by the DB.
-- Original company copy removed for the shipped product; every block seeds
-- neutral placeholder text the operator replaces from the Website module.

INSERT OR IGNORE INTO content_blocks (slug, title, body, kind, page, section, updated_at, updated_by) VALUES
  -- hero
  ('home.hero.eyebrow',    'Hero · Eyebrow',    'YOUR EYEBROW LINE',                                                                              'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.headline',   'Hero · Headline',   'Your headline goes here.',                                                                        'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.sub',        'Hero · Sub',        'A one-line supporting statement.',                                                                'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.body',       'Hero · Body',       'Introduce your company in two or three sentences: what you do, who it is for, and why it works. Edit this block from the Website module.', 'markdown', 'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.cta.01.label','Hero · CTA 1 label','Book a call',                                                                                    'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.cta.01.href', 'Hero · CTA 1 href', '/preq',                                                                                          'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.cta.02.label','Hero · CTA 2 label','See how we work',                                                                                'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.cta.02.href', 'Hero · CTA 2 href', '#process',                                                                                       'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),

  -- promise strip
  ('home.promise.line',    'Promise · Line',    'A short promise line for your company.',                                                          'text',     'home', 'promise',  strftime('%s','now') * 1000, 'system'),

  -- services intro
  ('home.services.eyebrow', 'Services · Eyebrow','SERVICES',                                                                                       'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.headline','Services · Headline','What you offer, in one line',                                                                   'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.sub',     'Services · Sub',    'One sentence framing the service list below.',                                                   'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.cta.label','Services · CTA label','Get started',                                                                                 'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.cta.href','Services · CTA href','/preq',                                                                                         'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),

  -- services items (6)
  ('home.services.01.title','Service 01 · Title','Service one',                                                                                    'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.01.body', 'Service 01 · Body', 'Describe this service in one or two sentences: what it is and the outcome it produces.',         'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.02.title','Service 02 · Title','Service two',                                                                                    'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.02.body', 'Service 02 · Body', 'Describe this service in one or two sentences: what it is and the outcome it produces.',         'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.03.title','Service 03 · Title','Service three',                                                                                  'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.03.body', 'Service 03 · Body', 'Describe this service in one or two sentences: what it is and the outcome it produces.',         'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.04.title','Service 04 · Title','Service four',                                                                                   'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.04.body', 'Service 04 · Body', 'Describe this service in one or two sentences: what it is and the outcome it produces.',         'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.05.title','Service 05 · Title','Service five',                                                                                   'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.05.body', 'Service 05 · Body', 'Describe this service in one or two sentences: what it is and the outcome it produces.',         'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.06.title','Service 06 · Title','Service six',                                                                                    'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.06.body', 'Service 06 · Body', 'Describe this service in one or two sentences: what it is and the outcome it produces.',         'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),

  -- process intro
  ('home.process.eyebrow', 'Process · Eyebrow', 'PROCESS',                                                                                        'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.headline','Process · Headline','How we work, in four steps',                                                                     'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),

  -- process steps (4)
  ('home.process.01.title','Step 01 · Title','Step one',                                                                                          'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.01.body', 'Step 01 · Body', 'Describe the first step of your process in one or two sentences.',                                  'markdown', 'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.02.title','Step 02 · Title','Step two',                                                                                          'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.02.body', 'Step 02 · Body', 'Describe the second step of your process in one or two sentences.',                                 'markdown', 'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.03.title','Step 03 · Title','Step three',                                                                                        'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.03.body', 'Step 03 · Body', 'Describe the third step of your process in one or two sentences.',                                  'markdown', 'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.04.title','Step 04 · Title','Step four',                                                                                         'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.04.body', 'Step 04 · Body', 'Describe the fourth step of your process in one or two sentences.',                                 'markdown', 'home', 'process',  strftime('%s','now') * 1000, 'system'),

  -- faq intro
  ('home.faq.eyebrow',  'FAQ · Eyebrow',  'FAQ',                                                                                                  'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.headline', 'FAQ · Headline', 'Questions we get asked',                                                                               'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),

  -- faq items (6)
  ('home.faq.01.q','FAQ 01 · Question','Your first frequently asked question goes here?',                                                         'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.01.a','FAQ 01 · Answer',  'Answer the question directly in two or three sentences.',                                                 'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.02.q','FAQ 02 · Question','Your second frequently asked question goes here?',                                                        'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.02.a','FAQ 02 · Answer',  'Answer the question directly in two or three sentences.',                                                 'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.03.q','FAQ 03 · Question','Your third frequently asked question goes here?',                                                         'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.03.a','FAQ 03 · Answer',  'Answer the question directly in two or three sentences.',                                                 'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.04.q','FAQ 04 · Question','Your fourth frequently asked question goes here?',                                                        'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.04.a','FAQ 04 · Answer',  'Answer the question directly in two or three sentences.',                                                 'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.05.q','FAQ 05 · Question','Your fifth frequently asked question goes here?',                                                         'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.05.a','FAQ 05 · Answer',  'Answer the question directly in two or three sentences.',                                                 'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.06.q','FAQ 06 · Question','Your sixth frequently asked question goes here?',                                                         'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.06.a','FAQ 06 · Answer',  'Answer the question directly in two or three sentences.',                                                 'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),

  -- final cta
  ('home.cta.eyebrow',       'Final CTA · Eyebrow',       'LET''S TALK',                                                                          'text',     'home', 'cta',      strftime('%s','now') * 1000, 'system'),
  ('home.cta.headline',      'Final CTA · Headline',      'A closing call-to-action headline',                                                    'text',     'home', 'cta',      strftime('%s','now') * 1000, 'system'),
  ('home.cta.body',          'Final CTA · Body',          'One or two sentences inviting the reader to take the next step with your company.',    'markdown', 'home', 'cta',      strftime('%s','now') * 1000, 'system'),
  ('home.cta.button.label',  'Final CTA · Button label',  'Book a call',                                                                          'text',     'home', 'cta',      strftime('%s','now') * 1000, 'system'),
  ('home.cta.button.href',   'Final CTA · Button href',   '/preq',                                                                                'text',     'home', 'cta',      strftime('%s','now') * 1000, 'system'),
  ('home.cta.disclaimer',    'Final CTA · Disclaimer',    'A short reassurance line.',                                                            'text',     'home', 'cta',      strftime('%s','now') * 1000, 'system'),

  -- footer
  ('home.footer.tagline',    'Footer · Tagline',          'A one-line tagline for your company.',                                                 'text',     'home', 'footer',   strftime('%s','now') * 1000, 'system'),
  ('home.footer.copyright',  'Footer · Copyright',        '© 2026 Your Company. All rights reserved.',                                            'text',     'home', 'footer',   strftime('%s','now') * 1000, 'system');

-- Flip Website module surface key (no-op if same) so registry/UI reflect shipping state.
UPDATE modules SET surface = 'website', updated_at = strftime('%s','now') * 1000 WHERE slug = 'website';
