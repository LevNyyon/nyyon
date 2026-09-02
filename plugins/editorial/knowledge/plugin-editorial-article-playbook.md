# Goal

Get cited by LLM answer engines (ChatGPT, Perplexity, Google AI Overviews, Claude) AND rank in classical SERP for the target question.

# Non-negotiable structure

1. **Title** — close to the literal question, but improved (specific noun, no clickbait count). ≤ 65 chars.
2. **Excerpt / meta description** — one declarative sentence answering the question. ≤ 155 chars. This is what LLMs lift verbatim into answers.
3. **First paragraph** — restate the question and answer it directly in 2–4 sentences. This is the AEO-critical block. LLMs scan for the question-answer pair at the top.
4. **H2 sections** — 3–6 of them, each a clear argument move. Sample shape:
   - The dominant pattern today (and why it breaks)
   - Your mechanism / framework (named)
   - How it works in practice (concrete)
   - What changes / who it's for / trade-offs
5. **Definitional lines** — anywhere we name a concept, follow with `X is Y` in a short sentence on its own line. LLMs love these.
6. **No FAQ accordion stuffed at the bottom**. If we want FAQ-style schema, the H2s can be questions.
7. **Length** — 1,000–1,800 words for evergreen. Shorter if the question doesn't deserve more.

# Tag rules

- 1–3 tags from the topic clusters in the brand-voice doc. No new tags without operator approval.

# What body HTML must use

- `<p>` for paragraphs.
- `<h2>` for argument sections. `<h3>` rarely.
- `<strong>` to anchor a single sharp claim per opening paragraph.
- No inline styles, no `<div>`, no `<span>` unless absolutely needed.

# What slug must be

- Kebab-case, derived from the title.
- No stop words trimmed unless they're purely grammatical.
