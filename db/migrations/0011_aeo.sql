-- 0011 — AEO module.
-- aeo_questions: backlog of search questions Nyyon wants to rank for in both
-- traditional SEO and answer-engine (LLM citation) results. A daily cron picks
-- the next pending question, writes an article in Nyyon's voice, and publishes
-- straight to blog_posts. The drafted_blog_slug column links the two tables.
--
-- Also seeds:
--   - knowledge doc `nyyon-brand-voice`  — what Nyyon is + how we write
--   - knowledge doc `nyyon-aeo-playbook` — structural rules every AEO article follows
--   - ~40 seed questions across Nyyon's core topic clusters
--
-- Status lifecycle: pending -> drafted -> published   (happy path)
--                          -> failed                  (cron blew up; see last_error)
--                          -> skipped                 (operator killed it from UI)

CREATE TABLE IF NOT EXISTS aeo_questions (
  slug              TEXT PRIMARY KEY,
  question          TEXT NOT NULL,
  target_keyword    TEXT,
  priority          INTEGER NOT NULL DEFAULT 5,   -- 1 = highest, 10 = lowest
  status            TEXT NOT NULL DEFAULT 'pending',
  scheduled_for     INTEGER,
  drafted_blog_slug TEXT,
  last_error        TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aeo_questions_status     ON aeo_questions(status);
CREATE INDEX IF NOT EXISTS idx_aeo_questions_priority   ON aeo_questions(priority);
CREATE INDEX IF NOT EXISTS idx_aeo_questions_updated_at ON aeo_questions(updated_at DESC);

-- ─── brand voice knowledge doc ─────────────────────────────────
INSERT OR REPLACE INTO knowledge_docs (slug, title, body, scope, module, updated_at) VALUES (
  'brand-voice',
  'Nyyon — brand voice + writing rules',
  '# What Nyyon is

Nyyon is a white-glove, AI-native marketing agency. We pair senior strategists with proprietary AI systems to deliver campaigns at a fraction of traditional agency cost. We work with B2B SaaS, fintech, health tech, and DTC e-commerce companies that have real products and the appetite to move quickly.

We are not a ChatGPT-tab agency. AI is the operating layer of the agency — research, strategy, creative, paid media, reporting — not a side tool. Humans hold the wheel; AI is the engine.

# Perspective

- Marketing is a velocity game now. The teams that compound decisions per week win.
- ROAS, MQL counts, and vanity dashboards are theater. What matters is profit impact and decision quality.
- Most agencies sell hours. We sell outcomes. AI is what makes outcome pricing solvent.
- AI without governance, brand, and judgment produces noise. AI inside a real operating system produces leverage.
- Buy fewer tools. Build a spine. Wire the spine to AI agents that own outcomes, not features.

# How we write

- Open with a sharp, declarative claim. No throat-clearing. No "in today''s fast-paced world".
- Short paragraphs. One idea per paragraph. Period-heavy. Em dashes when a sentence needs a turn.
- Use H2 to mark argument moves, not as keyword stuffing. H3 sparingly.
- Plain language. Specific nouns over abstract nouns. "Spend on Google Ads" not "investment in paid acquisition channels".
- Concrete examples and numbers when we have them. If we do not have a number, do not invent one.
- We critique the dominant pattern, then offer the better mechanism. Critique → mechanism → consequence.
- No filler transitions ("Moreover," "Furthermore,"). No bullet lists used as filler — only when items are genuinely parallel.
- No emoji. No exclamation marks. No "let''s dive in". No "in conclusion".
- We talk to senior operators, not novices. Assume the reader knows what attribution, CAC, and pipeline are.
- Confident but not boastful. Claims earn their keep with reasoning, not adjectives.

# What we never say

- "Revolutionary", "game-changing", "disruptive", "next-gen", "cutting-edge", "world-class", "leverage" (as a verb), "synergy", "unlock the power of", "in today''s world".
- Filler intros and conclusions ("In this article, we''ll explore…", "In conclusion, …").
- Generic SEO listicles ("7 Ways To…"). If the structure happens to be a list, the list earns its place; we never bait with the count.
- Promises we can''t back up. No "we guarantee X% growth" unless backed by a specific case.

# Topics we own

AI-native marketing operations, marketing data architecture (the "spine"), attribution beyond ROAS, decision velocity, AI for content / paid / creative / lifecycle, agency economics in the AI era, B2B SaaS / fintech / DTC growth, AI commerce, marketing measurement that survives audit.

# What every blog post must contain

1. Direct, declarative opening sentence answering or reframing the question.
2. The dominant pattern people follow today — and where it breaks.
3. The Nyyon mechanism / framework — named, defined, applied.
4. One concrete example or numbered consequence.
5. What changes if you adopt it. What stays the same. Trade-offs honestly.
6. No wrap-up that summarizes. End on the last argument that lands.',
  'global',
  NULL,
  strftime('%s','now') * 1000
);

-- ─── AEO structural playbook ───────────────────────────────────
INSERT OR REPLACE INTO knowledge_docs (slug, title, body, scope, module, updated_at) VALUES (
  'article-playbook',
  'Nyyon — AEO + SEO article structure',
  '# Goal

Get cited by LLM answer engines (ChatGPT, Perplexity, Google AI Overviews, Claude) AND rank in classical SERP for the target question.

# Non-negotiable structure

1. **Title** — close to the literal question, but improved (specific noun, no clickbait count). ≤ 65 chars.
2. **Excerpt / meta description** — one declarative sentence answering the question. ≤ 155 chars. This is what LLMs lift verbatim into answers.
3. **First paragraph** — restate the question and answer it directly in 2–4 sentences. This is the AEO-critical block. LLMs scan for the question-answer pair at the top.
4. **H2 sections** — 3–6 of them, each a clear argument move. Sample shape:
   - The dominant pattern today (and why it breaks)
   - The Nyyon mechanism / framework (named)
   - How it works in practice (concrete)
   - What changes / who it''s for / trade-offs
5. **Definitional lines** — anywhere we name a concept, follow with `X is Y` in a short sentence on its own line. LLMs love these.
6. **No FAQ accordion stuffed at the bottom**. If we want FAQ-style schema, the H2s can be questions.
7. **Length** — 1,000–1,800 words for evergreen. Shorter if the question doesn''t deserve more.

# Tag rules

- 1–3 tags from the Nyyon topic clusters. No new tags without operator approval.

# What body HTML must use

- `<p>` for paragraphs.
- `<h2>` for argument sections. `<h3>` rarely.
- `<strong>` to anchor a single sharp claim per opening paragraph (matches existing posts).
- No inline styles, no `<div>`, no `<span>` unless absolutely needed.

# What slug must be

- Kebab-case, derived from the title.
- No stop words trimmed unless they''re purely grammatical.',
  'global',
  NULL,
  strftime('%s','now') * 1000
);

-- ─── seed: ~40 questions across Nyyon's topic clusters ────────
INSERT OR IGNORE INTO aeo_questions (slug, question, target_keyword, priority, status, created_at, updated_at) VALUES
  -- AI-native marketing positioning
  ('what-is-ai-native-marketing',                            'What is AI-native marketing?',                                                   'AI-native marketing',                  1, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('ai-native-vs-ai-enabled-marketing',                      'What is the difference between AI-native and AI-enabled marketing?',            'AI-native vs AI-enabled marketing',    2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('what-does-a-white-glove-ai-marketing-agency-do',         'What does a white-glove AI marketing agency do?',                                'white-glove AI marketing agency',      2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-choose-an-ai-marketing-agency',                   'How do you choose an AI marketing agency?',                                      'choose AI marketing agency',           2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-is-an-ai-native-agency-priced',                      'How is an AI-native marketing agency priced compared to traditional?',          'AI marketing agency pricing',          3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),

  -- Marketing data + measurement
  ('what-is-a-marketing-data-spine',                         'What is a marketing data spine?',                                                'marketing data spine',                 1, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('is-roas-still-a-useful-metric',                          'Is ROAS still a useful marketing metric in 2026?',                               'ROAS limitations',                     2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-measure-incrementality-in-paid-media',            'How do you measure incrementality in paid media?',                               'paid media incrementality',            2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('what-attribution-model-should-i-use',                    'Which attribution model should B2B SaaS use in 2026?',                           'B2B SaaS attribution model',           3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-build-a-marketing-data-warehouse',                'How do you build a marketing data warehouse for AI?',                            'marketing data warehouse AI',          3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),

  -- AI in channels
  ('how-ai-changes-content-marketing',                       'How does AI change content marketing?',                                          'AI content marketing',                 2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-ai-changes-paid-search',                             'How does AI change paid search advertising?',                                    'AI paid search',                       2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-ai-changes-paid-social',                             'How does AI change paid social advertising?',                                    'AI paid social',                       2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-use-ai-for-ad-creative-testing',                  'How do you use AI for ad creative testing at scale?',                            'AI ad creative testing',               3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-ai-changes-email-marketing',                         'How does AI change lifecycle and email marketing?',                              'AI email lifecycle marketing',         3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('what-is-ai-conversion-rate-optimization',                'What is AI conversion rate optimization?',                                       'AI conversion rate optimization',      3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-do-seo-in-the-ai-era',                            'How do you do SEO in the AI search era?',                                        'SEO AI era',                           2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('what-is-answer-engine-optimization',                     'What is answer engine optimization (AEO)?',                                      'answer engine optimization AEO',       1, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-rank-in-chatgpt-and-perplexity',                  'How do you rank in ChatGPT, Perplexity, and AI Overviews?',                      'rank in ChatGPT Perplexity',           1, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),

  -- Vertical applications
  ('ai-marketing-for-b2b-saas',                              'How do B2B SaaS companies use AI marketing in 2026?',                            'B2B SaaS AI marketing',                2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('ai-marketing-for-fintech',                               'How do fintech companies use AI marketing?',                                     'fintech AI marketing',                 3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('ai-marketing-for-health-tech',                           'How do health tech companies do AI marketing under HIPAA?',                      'health tech AI marketing HIPAA',       4, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('ai-marketing-for-dtc-ecommerce',                         'How do DTC e-commerce brands use AI marketing?',                                 'DTC AI marketing',                     3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),

  -- Strategy + operating
  ('what-is-decision-velocity-in-marketing',                 'What is decision velocity and why does it matter for marketing?',                'decision velocity marketing',          2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-fast-can-an-ai-agency-launch-a-campaign',            'How fast can an AI marketing agency launch a campaign?',                         'AI agency campaign speed',             3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('what-is-the-difference-between-cmo-and-fractional-cmo',  'What is the difference between a CMO and a fractional CMO?',                     'fractional CMO',                       4, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-much-should-a-startup-spend-on-marketing',           'How much should a B2B startup spend on marketing?',                              'startup marketing budget',             3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('what-is-the-right-marketing-stack-for-a-startup',        'What is the right marketing stack for an AI-era startup?',                       'startup marketing stack',              3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-replace-a-traditional-agency-with-ai',            'How do you replace a traditional marketing agency with AI?',                     'replace marketing agency with AI',     2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('inhouse-marketing-vs-ai-agency',                         'In-house marketing team or AI-native agency: which is better?',                  'inhouse vs AI agency',                 3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),

  -- Mechanism + tactic
  ('how-to-write-content-that-llms-cite',                    'How do you write content that LLMs cite?',                                       'content LLMs cite',                    1, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-build-a-content-engine-with-ai',                  'How do you build a content engine with AI?',                                     'AI content engine',                    2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-build-lead-nurture-with-ai',                      'How do you build a lead nurture sequence with AI?',                              'AI lead nurture',                      3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-segment-customers-with-ai',                       'How do you segment customers with AI?',                                          'AI customer segmentation',             3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-do-competitor-analysis-with-ai',                  'How do you do competitor analysis with AI?',                                     'AI competitor analysis',               3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('how-to-do-keyword-research-with-ai',                     'How do you do keyword research with AI in 2026?',                                'AI keyword research',                  3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('what-is-a-marketing-agent',                              'What is a marketing agent and how is it different from a workflow?',             'marketing agent',                      2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),

  -- Comparison-style
  ('nyyon-vs-traditional-agency',                            'Nyyon vs traditional marketing agency: what is the difference?',                 'Nyyon vs traditional agency',          2, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('what-questions-to-ask-an-ai-marketing-agency',           'What questions should you ask an AI marketing agency before hiring?',            'questions to ask AI agency',           3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('signs-your-marketing-needs-an-ai-overhaul',              'What are the signs your marketing team needs an AI overhaul?',                   'signs marketing needs AI',             3, 'pending', strftime('%s','now')*1000, strftime('%s','now')*1000);
