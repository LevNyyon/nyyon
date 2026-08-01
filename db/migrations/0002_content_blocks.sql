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

INSERT OR IGNORE INTO content_blocks (slug, title, body, kind, page, section, updated_at, updated_by) VALUES
  -- hero
  ('home.hero.eyebrow',    'Hero · Eyebrow',    'AI-NATIVE · WHITE-GLOVE',                                                                        'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.headline',   'Hero · Headline',   'Marketing that thinks faster than your market moves.',                                            'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.sub',        'Hero · Sub',        'AI-native marketing, white-glove delivery.',                                                      'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.body',       'Hero · Body',       'Nyyon is a white-glove marketing agency built on AI from day one. Elite strategists paired with proprietary AI systems craft campaigns that convert — faster, sharper, at a fraction of traditional agency cost.', 'markdown', 'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.cta.01.label','Hero · CTA 1 label','Book a strategy call',                                                                            'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.cta.01.href', 'Hero · CTA 1 href', '/preq',                                                                                           'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.cta.02.label','Hero · CTA 2 label','See how we work',                                                                                 'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),
  ('home.hero.cta.02.href', 'Hero · CTA 2 href', '#process',                                                                                        'text',     'home', 'hero',     strftime('%s','now') * 1000, 'system'),

  -- promise strip
  ('home.promise.line',    'Promise · Line',    'No fluff. Just results.',                                                                         'text',     'home', 'promise',  strftime('%s','now') * 1000, 'system'),

  -- services intro
  ('home.services.eyebrow', 'Services · Eyebrow','SERVICES',                                                                                       'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.headline','Services · Headline','Full-stack AI-powered marketing, done for you',                                                  'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.sub',     'Services · Sub',    'Every service is enhanced by proprietary AI workflows — premium quality at startup speed.',      'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.cta.label','Services · CTA label','Get started',                                                                                  'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.cta.href','Services · CTA href','/preq',                                                                                          'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),

  -- services items (6)
  ('home.services.01.title','Service 01 · Title','AI-driven strategy & positioning',                                                                'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.01.body', 'Service 01 · Body', 'Market and competitor analysis at depth no human team can match alone. We surface the wedge, name the audience, and lock the positioning before a dollar is spent.', 'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.02.title','Service 02 · Title','Content engine',                                                                                  'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.02.body', 'Service 02 · Body', 'Blog, social, email, and ad copy produced and refined on a continuous cadence. AI drafts, senior strategists edit. Volume without the voice tax.', 'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.03.title','Service 03 · Title','Performance creative',                                                                            'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.03.body', 'Service 03 · Body', 'AI-designed ad creative tested at scale. Winners are identified in days, not quarters, and pushed to spend automatically.', 'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.04.title','Service 04 · Title','Paid media & growth',                                                                             'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.04.body', 'Service 04 · Body', 'Multi-platform campaigns with dynamic optimization. Google, Meta, LinkedIn, TikTok — one operating system across the stack.', 'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.05.title','Service 05 · Title','Marketing automation',                                                                            'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.05.body', 'Service 05 · Body', 'Lead nurture, segmentation, and lifecycle flows that move the right prospects forward without manual triage.', 'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.06.title','Service 06 · Title','Brand & web design',                                                                              'text',     'home', 'services', strftime('%s','now') * 1000, 'system'),
  ('home.services.06.body', 'Service 06 · Body', 'Identity, design system, and conversion-tuned landing pages built to match the rest of the engine.', 'markdown', 'home', 'services', strftime('%s','now') * 1000, 'system'),

  -- process intro
  ('home.process.eyebrow', 'Process · Eyebrow', 'PROCESS',                                                                                         'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.headline','Process · Headline','How Nyyon delivers results in four steps',                                                         'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),

  -- process steps (4)
  ('home.process.01.title','Step 01 · Title','Deep-dive discovery',                                                                                 'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.01.body', 'Step 01 · Body', '48-hour AI-powered audit of your market, competitors, channels, and current funnel. You leave the kickoff knowing where the gaps are.', 'markdown', 'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.02.title','Step 02 · Title','Strategy & creative sprint',                                                                          'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.02.body', 'Step 02 · Body', 'Co-created campaigns drafted by AI, refined by senior talent. Strategy, creative, and channel plan in one cohesive ship.', 'markdown', 'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.03.title','Step 03 · Title','Launch & optimize',                                                                                   'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.03.body', 'Step 03 · Body', 'Real-time monitoring with daily iteration. Underperformers get killed in 72 hours; winners get scaled.', 'markdown', 'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.04.title','Step 04 · Title','Report & scale',                                                                                      'text',     'home', 'process',  strftime('%s','now') * 1000, 'system'),
  ('home.process.04.body', 'Step 04 · Body', 'Transparent dashboards on the metrics that matter. Doubling down on winners; compounding monthly.', 'markdown', 'home', 'process',  strftime('%s','now') * 1000, 'system'),

  -- faq intro
  ('home.faq.eyebrow',  'FAQ · Eyebrow',  'FAQ',                                                                                                   'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.headline', 'FAQ · Headline', 'Questions we get asked',                                                                                 'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),

  -- faq items (6)
  ('home.faq.01.q','FAQ 01 · Question','What does "AI-native" actually mean?',                                                                       'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.01.a','FAQ 01 · Answer',  'AI is wired into every step — research, strategy, creative, paid media, reporting. Not a ChatGPT tab open in the background; an operating layer across the agency.', 'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.02.q','FAQ 02 · Question','Will my brand feel generic or "AI-generated"?',                                                              'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.02.a','FAQ 02 · Answer',  'Every output is reviewed and refined by senior strategists and creatives before it ships. AI is the engine; humans hold the wheel.', 'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.03.q','FAQ 03 · Question','What kind of companies do you work with?',                                                                   'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.03.a','FAQ 03 · Answer',  'B2B SaaS, fintech, health tech, and DTC e-commerce — anyone with a real product and the appetite to move quickly.', 'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.04.q','FAQ 04 · Question','How fast can you start?',                                                                                    'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.04.a','FAQ 04 · Answer',  'One week from signed engagement to kickoff. Live campaigns running in two to three weeks.',                  'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.05.q','FAQ 05 · Question','Do I need a long-term contract?',                                                                            'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.05.a','FAQ 05 · Answer',  'No. We start with a project or a 90-day sprint. Retainers happen because the work earns them.',              'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.06.q','FAQ 06 · Question','How is Nyyon different from other agencies?',                                                                'text',     'home', 'faq',      strftime('%s','now') * 1000, 'system'),
  ('home.faq.06.a','FAQ 06 · Answer',  'Most agencies sell hours. We sell outcomes. AI lets us deliver senior-team quality at a fraction of the headcount cost.', 'markdown', 'home', 'faq',      strftime('%s','now') * 1000, 'system'),

  -- final cta
  ('home.cta.eyebrow',       'Final CTA · Eyebrow',       'LET''S TALK',                                                                            'text',     'home', 'cta',      strftime('%s','now') * 1000, 'system'),
  ('home.cta.headline',      'Final CTA · Headline',      'Ready to see what AI-native marketing can do for you?',                                  'text',     'home', 'cta',      strftime('%s','now') * 1000, 'system'),
  ('home.cta.body',          'Final CTA · Body',          'Book a free 30-minute strategy call. We will audit your current marketing and show you exactly where AI can accelerate growth.', 'markdown', 'home', 'cta',      strftime('%s','now') * 1000, 'system'),
  ('home.cta.button.label',  'Final CTA · Button label',  'Book your free strategy call',                                                            'text',     'home', 'cta',      strftime('%s','now') * 1000, 'system'),
  ('home.cta.button.href',   'Final CTA · Button href',   '/preq',                                                                                   'text',     'home', 'cta',      strftime('%s','now') * 1000, 'system'),
  ('home.cta.disclaimer',    'Final CTA · Disclaimer',    'No commitment. No pitch deck. Just an honest conversation.',                              'text',     'home', 'cta',      strftime('%s','now') * 1000, 'system'),

  -- footer
  ('home.footer.tagline',    'Footer · Tagline',          'White-glove AI-native marketing that moves as fast as you do.',                          'text',     'home', 'footer',   strftime('%s','now') * 1000, 'system'),
  ('home.footer.copyright',  'Footer · Copyright',        '© 2026 Nyyon. All rights reserved.',                                                     'text',     'home', 'footer',   strftime('%s','now') * 1000, 'system');

-- Flip Website module surface key (no-op if same) so registry/UI reflect shipping state.
UPDATE modules SET surface = 'website', updated_at = strftime('%s','now') * 1000 WHERE slug = 'website';
