-- 0009 — seed content_blocks for the Engagement + Takes sections so they
-- show up in ops Website → Content tab and are editable like the rest.
-- Slugs match useBlock() calls in web-public/src/components/{Engagement,Takes}.tsx.

INSERT OR IGNORE INTO content_blocks (slug, title, body, kind, page, section, updated_at, updated_by) VALUES
  -- engagement intro
  ('home.engagement.eyebrow',  'Engagement · Eyebrow',  'HOW IT WORKS',                                                                                  'text',     'home', 'engagement', strftime('%s','now') * 1000, 'system'),
  ('home.engagement.headline', 'Engagement · Headline', 'A four-step engagement that compounds.',                                                        'text',     'home', 'engagement', strftime('%s','now') * 1000, 'system'),

  -- engagement steps (4)
  ('home.engagement.01.title', 'Engagement Step 01 · Title', 'Audit the funnel',                                                                          'text',     'home', 'engagement', strftime('%s','now') * 1000, 'system'),
  ('home.engagement.01.body',  'Engagement Step 01 · Body',  'First two weeks I map your stack end to end. Ads, landing pages, forms, CRM, handoff, close. I show you exactly where leads are leaking and where AI plugs it.', 'markdown', 'home', 'engagement', strftime('%s','now') * 1000, 'system'),
  ('home.engagement.02.title', 'Engagement Step 02 · Title', 'Build the lead engine first',                                                               'text',     'home', 'engagement', strftime('%s','now') * 1000, 'system'),
  ('home.engagement.02.body',  'Engagement Step 02 · Body',  'Outbound that sounds human. Inbound that pre-qualifies and routes. Paid creative that compounds testing. Lead scoring that tells sales who to call first. We start with the play that moves the biggest number.', 'markdown', 'home', 'engagement', strftime('%s','now') * 1000, 'system'),
  ('home.engagement.03.title', 'Engagement Step 03 · Title', 'Run it and iterate',                                                                        'text',     'home', 'engagement', strftime('%s','now') * 1000, 'system'),
  ('home.engagement.03.body',  'Engagement Step 03 · Body',  'I don''t ship and disappear. I own the system, watch the metrics weekly, and rebuild what isn''t working. You stay in the loop without having to project manage me.', 'markdown', 'home', 'engagement', strftime('%s','now') * 1000, 'system'),
  ('home.engagement.04.title', 'Engagement Step 04 · Title', 'Layer the next system',                                                                     'text',     'home', 'engagement', strftime('%s','now') * 1000, 'system'),
  ('home.engagement.04.body',  'Engagement Step 04 · Body',  'Once leads flow, we layer: attribution, sales enablement, retention loops, internal AI tools. Your AI stack compounds month over month instead of stalling at v1.', 'markdown', 'home', 'engagement', strftime('%s','now') * 1000, 'system'),

  -- takes intro
  ('home.takes.eyebrow',     'Takes · Eyebrow',     'WHAT IT TAKES',                                                                                     'text',     'home', 'takes',      strftime('%s','now') * 1000, 'system'),
  ('home.takes.headline.a',  'Takes · Headline A',  'Moving revenue with AI',                                                                            'text',     'home', 'takes',      strftime('%s','now') * 1000, 'system'),
  ('home.takes.headline.b',  'Takes · Headline B',  'is a people problem first.',                                                                        'text',     'home', 'takes',      strftime('%s','now') * 1000, 'system'),
  ('home.takes.sub',         'Takes · Sub',         'You need someone who can do all four of these.' || char(10) || 'Under one retainer, with one accountable owner.', 'markdown', 'home', 'takes', strftime('%s','now') * 1000, 'system'),

  -- takes tiles (4)
  ('home.takes.01.title', 'Take 01 · Title', 'Read your funnel',                                                                                          'text',     'home', 'takes',      strftime('%s','now') * 1000, 'system'),
  ('home.takes.01.body',  'Take 01 · Body',  'Map ads, landing, form, CRM, handoff like an operator. Find where leads leak.',                              'markdown', 'home', 'takes',      strftime('%s','now') * 1000, 'system'),
  ('home.takes.02.title', 'Take 02 · Title', 'Own the creative',                                                                                          'text',     'home', 'takes',      strftime('%s','now') * 1000, 'system'),
  ('home.takes.02.body',  'Take 02 · Body',  'Higgsfield, Midjourney, Suno, ElevenLabs, and friends. Generate the visuals, video, voice, and copy your funnel actually needs.', 'markdown', 'home', 'takes',      strftime('%s','now') * 1000, 'system'),
  ('home.takes.03.title', 'Take 03 · Title', 'Build the system',                                                                                          'text',     'home', 'takes',      strftime('%s','now') * 1000, 'system'),
  ('home.takes.03.body',  'Take 03 · Body',  'Agents, automations, integrations, infra. Production grade, not a Zapier patchwork.',                       'markdown', 'home', 'takes',      strftime('%s','now') * 1000, 'system'),
  ('home.takes.04.title', 'Take 04 · Title', 'Own it after launch',                                                                                       'text',     'home', 'takes',      strftime('%s','now') * 1000, 'system'),
  ('home.takes.04.body',  'Take 04 · Body',  'Watch the numbers, fix what breaks, rebuild what isn''t working. Long bond, not a project.',                'markdown', 'home', 'takes',      strftime('%s','now') * 1000, 'system');
