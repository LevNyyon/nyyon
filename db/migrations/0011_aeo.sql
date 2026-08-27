-- 0011 — AEO module.
-- aeo_questions: backlog of search questions the operator wants to rank for in
-- both traditional SEO and answer-engine (LLM citation) results. A daily cron
-- picks the next pending question, writes an article in the configured brand
-- voice, and publishes straight to blog_posts. The drafted_blog_slug column
-- links the two tables.
--
-- Also seeds:
--   - knowledge doc `brand-voice`      — placeholder brand + voice doc the operator fills in
--   - knowledge doc `article-playbook` — structural rules every AEO article follows
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

-- ─── brand voice knowledge doc (placeholder) ───────────────────
-- Original company voice content removed for the shipped product; the operator
-- fills in each section from the Knowledge module before running the AEO writer.
INSERT OR REPLACE INTO knowledge_docs (slug, title, body, scope, module, updated_at) VALUES (
  'brand-voice',
  'Brand voice + writing rules',
  '# What this doc is

The brand + voice document the article writer follows. Replace each section below with your company''s real content before running the AEO writer.

# What your company is

Describe your company in two or three sentences: what you sell, who it is for, and what makes the work different.

# Perspective

List the handful of opinions your content consistently argues. These become the through-line of every article.

# How we write

- Open with a direct, declarative claim. No throat-clearing.
- Short paragraphs. One idea per paragraph.
- Plain language. Specific nouns over abstract nouns.
- Concrete examples and numbers when you have them. If you do not have a number, do not invent one.
- No filler transitions. No emoji. No exclamation marks.

# What we never say

List banned words and phrases here: hype adjectives, filler intros and conclusions, promises you cannot back up.

# Topics we own

List the topic clusters your content should stay inside.

# What every blog post must contain

1. Direct, declarative opening sentence answering or reframing the question.
2. The dominant pattern people follow today, and where it breaks.
3. Your named mechanism or framework, defined and applied.
4. One concrete example or numbered consequence.
5. What changes if the reader adopts it. What stays the same. Trade-offs honestly.
6. No wrap-up that summarizes. End on the last argument that lands.',
  'global',
  NULL,
  strftime('%s','now') * 1000
);

-- ─── AEO structural playbook ───────────────────────────────────
INSERT OR REPLACE INTO knowledge_docs (slug, title, body, scope, module, updated_at) VALUES (
  'article-playbook',
  'AEO + SEO article structure',
  '# Goal

Get cited by LLM answer engines (ChatGPT, Perplexity, Google AI Overviews, Claude) AND rank in classical SERP for the target question.

# Non-negotiable structure

1. **Title** — close to the literal question, but improved (specific noun, no clickbait count). ≤ 65 chars.
2. **Excerpt / meta description** — one declarative sentence answering the question. ≤ 155 chars. This is what LLMs lift verbatim into answers.
3. **First paragraph** — restate the question and answer it directly in 2–4 sentences. This is the AEO-critical block. LLMs scan for the question-answer pair at the top.
4. **H2 sections** — 3–6 of them, each a clear argument move. Sample shape:
   - The dominant pattern today (and why it breaks)
   - Your mechanism / framework (named)
   - How it works in practice (concrete)
   - What changes / who it''s for / trade-offs
5. **Definitional lines** — anywhere we name a concept, follow with `X is Y` in a short sentence on its own line. LLMs love these.
6. **No FAQ accordion stuffed at the bottom**. If we want FAQ-style schema, the H2s can be questions.
7. **Length** — 1,000–1,800 words for evergreen. Shorter if the question doesn''t deserve more.

# Tag rules

- 1–3 tags from the topic clusters in the brand-voice doc. No new tags without operator approval.

# What body HTML must use

- `<p>` for paragraphs.
- `<h2>` for argument sections. `<h3>` rarely.
- `<strong>` to anchor a single sharp claim per opening paragraph.
- No inline styles, no `<div>`, no `<span>` unless absolutely needed.

# What slug must be

- Kebab-case, derived from the title.
- No stop words trimmed unless they''re purely grammatical.',
  'global',
  NULL,
  strftime('%s','now') * 1000
);

-- Seed questions removed for the shipped product; the operator adds questions
-- from the AEO module UI.
