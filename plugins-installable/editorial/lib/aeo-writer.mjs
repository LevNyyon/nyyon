// Editorial plugin — aeo-writer. Ported from workers/api/src/lib/aeo-writer.js.
// Pulls the next pending question, drafts an article in the brand voice via the
// llm gateway, and saves it as a DRAFT to plugin_editorial_blog_posts. Fired by
// the daily cron (run_aeo_cron wrapper tool) AND the manual "draft now" button.
//
// Plugin capability contract: this file imports NOTHING; every exported fn
// takes `api` first. Shared helpers from the host's db.js / aeo-interview.js /
// aeo-taste.js are duplicated inline (lib files cannot import each other).
//
// Tables:    plugin_editorial_blog_posts, plugin_editorial_aeo_questions (r/w)
// Knowledge: reads host brand-voice, personal-voice, article-playbook;
//            reads own plugin-editorial-editorial-taste.
// Gateways:  llm(text, json), outbox(begin, sent, failed).
//
// PORT NOTES (behavior deltas, all documented in the conversion report):
// - queueNyoMessage (host nyo_messages) is not writable from a plugin: the
//   notification content rides the activity bus (api.log kind 'nyo_message',
//   payload carries the full text) AND is returned on the result as
//   `nyo_message` so the calling tool can surface it.
// - logWorkflowRun (host workflow_runs) becomes api.log('workflow_run', ...).
// - Images: this build has no image renderer. The writer produces text only,
//   so there is no cover, figure or featured-image step anywhere in it.

const now = () => Date.now();

// ─── inline duplicates: blog posts store (see blog-db.mjs) ──────────────────
function stripDashes(s) {
  if (s == null) return s;
  return String(s).replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, '-');
}

async function readBlogPostRow(api, slug) {
  return api.db.prepare('SELECT * FROM plugin_editorial_blog_posts WHERE slug = ?').bind(slug).first();
}

async function listBlogPostRows(api, { limit = 200, publishedOnly = true } = {}) {
  const sql = publishedOnly
    ? 'SELECT slug, title, excerpt, tags, published_at, published, updated_at, updated_by FROM plugin_editorial_blog_posts WHERE published = 1 ORDER BY published_at DESC LIMIT ?'
    : 'SELECT slug, title, excerpt, tags, published_at, published, updated_at, updated_by FROM plugin_editorial_blog_posts ORDER BY published_at DESC LIMIT ?';
  const r = await api.db.prepare(sql).bind(limit).all();
  return r.results || [];
}

async function writeBlogPostRow(api, { slug, title, excerpt = null, body = null, tags = null, published_at = null, published = true, updated_by = 'operator' }) {
  const t = now();
  title = stripDashes(title); excerpt = stripDashes(excerpt); body = stripDashes(body);
  const existing = await readBlogPostRow(api, slug);
  const tagsJson = tags === null ? null : (typeof tags === 'string' ? tags : JSON.stringify(tags));
  if (existing) {
    await api.db.prepare(
      `UPDATE plugin_editorial_blog_posts SET title=?, excerpt=?, body=?, tags=?, published_at=?, published=?, updated_at=?, updated_by=? WHERE slug=?`,
    ).bind(title, excerpt, body, tagsJson, published_at, published ? 1 : 0, t, updated_by, slug).run();
  } else {
    await api.db.prepare(
      `INSERT INTO plugin_editorial_blog_posts (slug, title, excerpt, body, tags, published_at, published, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(slug, title, excerpt, body, tagsJson, published_at, published ? 1 : 0, t, updated_by).run();
  }
  await api.log('blog_post_updated', { slug, title, actor: updated_by });
  return readBlogPostRow(api, slug);
}

async function patchBlogPostRow(api, slug, patch = {}) {
  const existing = await readBlogPostRow(api, slug);
  if (!existing) throw new Error(`blog post not found: ${slug}`);
  return writeBlogPostRow(api, {
    slug,
    title:        patch.title        !== undefined ? patch.title        : existing.title,
    excerpt:      patch.excerpt      !== undefined ? patch.excerpt      : existing.excerpt,
    body:         patch.body         !== undefined ? patch.body         : existing.body,
    tags:         patch.tags         !== undefined ? patch.tags         : existing.tags,
    published_at: patch.published_at !== undefined ? patch.published_at : existing.published_at,
    published:    patch.published    !== undefined ? patch.published    : !!existing.published,
    updated_by:   patch.updated_by || 'nyo',
  });
}

// ─── inline duplicates: aeo_questions store (see blog-db.mjs) ───────────────
async function readAeoQuestionRow(api, slug) {
  return api.db.prepare('SELECT * FROM plugin_editorial_aeo_questions WHERE slug = ?').bind(slug).first();
}

async function nextPendingAeoQuestionRow(api) {
  return api.db.prepare(
    `SELECT * FROM plugin_editorial_aeo_questions
     WHERE status = 'pending'
       AND (scheduled_for IS NULL OR scheduled_for <= ?)
       AND (interview_status IS NULL OR interview_status = 'ready')
     ORDER BY priority ASC, created_at ASC LIMIT 1`,
  ).bind(now()).first();
}

async function nextScheduledReadyAeoQuestionRow(api) {
  return api.db.prepare(
    `SELECT * FROM plugin_editorial_aeo_questions
     WHERE status = 'pending'
       AND interview_status = 'ready'
       AND (scheduled_for IS NULL OR scheduled_for <= ?)
     ORDER BY priority ASC, created_at ASC LIMIT 1`,
  ).bind(now()).first();
}

async function markAeoQuestionPublishedRow(api, slug, blog_slug) {
  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET status='published', drafted_blog_slug=?, last_error=NULL, updated_at=? WHERE slug=?`,
  ).bind(blog_slug, now(), slug).run();
  await api.log('aeo_question_published', { question_slug: slug, blog_slug });
}

async function markAeoQuestionDraftedRow(api, slug, blog_slug) {
  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET status='drafted', drafted_blog_slug=?, last_error=NULL, updated_at=? WHERE slug=?`,
  ).bind(blog_slug, now(), slug).run();
  await api.log('aeo_question_drafted', { question_slug: slug, blog_slug });
}

async function markAeoQuestionFailedRow(api, slug, error_msg) {
  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET status='failed', last_error=?, attempts=attempts+1, updated_at=? WHERE slug=?`,
  ).bind(String(error_msg).slice(0, 1000), now(), slug).run();
  await api.log('aeo_question_failed', { slug, error: String(error_msg).slice(0, 200) });
}

// ─── inline duplicates: taste + expert context + interview kickoff ──────────
async function readTasteProfile(api) {
  const doc = await api.knowledge('plugin-editorial-editorial-taste').catch(() => null);
  return doc?.body || null;
}

function formatExpertContext(expertContextJson) {
  if (!expertContextJson) return null;
  let ctx;
  try { ctx = JSON.parse(expertContextJson); } catch { return null; }
  if (!ctx.questions || !ctx.answers) return null;
  const lines = ['## Expert interview — operator answers (treat as authoritative source material)', ''];
  ctx.questions.forEach((q, i) => { lines.push(`**Q${i + 1}: ${q}**`); });
  lines.push('', '**Operator answers:**', ctx.answers, '');
  lines.push('Use the operator\'s exact perspective, frameworks, examples, and opinions. This is first-hand expertise — build the article around it, do not dilute or genericise it.');
  return lines.join('\n');
}

const INTERVIEW_QUESTION_SYSTEM = `You help a marketing agency operator produce high-quality expert blog articles.

Given an AEO question / topic, generate EXACTLY 4 interview questions to ask the operator before writing.

The questions should extract:
1. The most common mistake they see companies make (gives the article a strong critique angle)
2. The mechanism / framework that actually works, from their experience (gives the article a concrete solution)
3. A specific client example, metric, or data point they can share — even anonymised (gives the article credibility)
4. The counterintuitive or non-obvious thing most people get wrong (gives the article a distinctive edge)

Rules:
- Each question is short, direct, conversational — like a smart editor asking a writer.
- Do NOT ask generic "what is X" questions. Assume the operator already knows the theory.
- The goal is to surface their LIVED EXPERIENCE and OPINION.
- No numbering, no preamble. Output only the 4 questions, one per line.`;

async function generateInterviewQuestionsInline(api, { question, target_keyword, notes }) {
  const taste = await readTasteProfile(api).catch(() => null);
  const prompt = [
    `AEO question to rank for: "${question}"`,
    target_keyword ? `Primary keyword: ${target_keyword}` : null,
    notes ? `Notes: ${notes}` : null,
    taste ? `\nThe founder's editorial taste (learned — angle the questions to surface what he cares about):\n${taste}` : null,
    '',
    'Generate the 4 interview questions now.',
  ].filter(Boolean).join('\n');
  const raw = await api.gateway('llm', 'text', { system: INTERVIEW_QUESTION_SYSTEM, prompt, model: 'gpt-4o-mini' });
  return String(raw).split('\n').map((q) => q.trim()).filter((q) => q.length > 10).slice(0, 4);
}

async function saveInterviewQuestionsInline(api, slug, questions) {
  const t = now();
  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET interview_status = 'pending', expert_context_json = ?, updated_at = ? WHERE slug = ?`,
  ).bind(JSON.stringify({ questions, answers: null, started_at: t }), t, slug).run();
  try { await api.log('aeo_interview_started', { slug, questions: questions?.length ?? null }); } catch { /* never fatal */ }
}

// ─── notifications + run records (host tables not writable from a plugin) ───
// The host original wrote nyo_messages (chat injection) and workflow_runs.
// Here both ride the activity bus; the nyo content is also returned to callers.
async function queueNyoNotice(api, { kind, ref_kind = null, ref_id = null, content, payload = null }) {
  try {
    await api.log('nyo_message', { kind, ref_kind, ref_id, content, payload: payload || {} });
  } catch { /* notification must never break the pipeline */ }
  return { kind, ref_kind, ref_id, content, payload };
}

async function logRun(api, run) {
  try { await api.log('workflow_run', run); } catch { /* run records are best-effort */ }
}

// ─── slug + tag helpers ─────────────────────────────────────────────────────
// Walk slug-1, slug-2, … until we find one that doesn't collide with an
// existing blog post row.
async function ensureUniqueSlug(api, candidate) {
  if (!(await readBlogPostRow(api, candidate))) return candidate;
  for (let i = 2; i <= 50; i++) {
    const next = `${candidate}-${i}`;
    if (!(await readBlogPostRow(api, next))) return next;
  }
  throw new Error(`could not find a free slug starting from ${candidate}`);
}

// Pull a deduped list of tags from already-published posts so the LLM sticks
// to the site's existing taxonomy instead of inventing new ones.
function collectKnownTags(posts) {
  const set = new Set();
  for (const p of posts) {
    if (!p.tags) continue;
    let arr = p.tags;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
    if (Array.isArray(arr)) arr.forEach((t) => set.add(t));
  }
  return [...set].sort();
}

// ─── prompts (verbatim from the host original) ──────────────────────────────
const SYSTEM_PROMPT = `You write blog posts for the operator's company.
You will be given:
- A target AEO/SEO question to answer
- The brand voice doc (how we write, what we never say — the source of truth for who the company is)
- The AEO article playbook (required structure)
- A short list of recently-published blog titles + excerpts (so you don't duplicate)
- OPTIONALLY: An expert interview — the operator's first-hand answers about this topic.
  When present, the interview is the most important input. Build the article around the
  operator's specific opinions, frameworks, examples, and language. Do NOT genericise
  or water down what they said. The interview is what makes this article different from
  every other AI-generated article on the same topic.

You MUST follow the brand voice and AEO playbook to the letter.

Return ONE JSON object — no prose, no markdown fence, just JSON — with these keys:
  slug:        string (kebab-case, derived from title, no stop-word trimming unless grammatical)
  title:       string (≤ 65 chars, close to the literal question but improved)
  excerpt:     string (≤ 155 chars, declarative one-sentence answer)
  body_html:   string (full article body as HTML: <p>, <strong>, <h2>, <h3> only)
  tags:        array of 1-2 strings, never more than 2 (use existing tag conventions where possible)

Constraints:
- Body length: 1,000–1,800 words.
- First paragraph must restate the question and answer it directly in 2–4 sentences (the AEO-critical block).
- No emoji, no exclamation marks, no "let's dive in", no "in conclusion".
- No banned phrases: revolutionary, game-changing, disruptive, next-gen, cutting-edge, world-class, leverage (as a verb), synergy, unlock the power of, in today's world.
- ABSOLUTE RULE: never use an en-dash or an em-dash, anywhere. Use commas, colons, or plain hyphens. Not a single one.
- Open with a sharp, declarative claim.
- Use H2 to mark argument moves, not as keyword stuffing.
- One concrete example or numbered consequence is required.`;

function buildUserPrompt({ question, target_keyword, brandVoice, aeoPlaybook, recentPosts, knownTags, expertContext }) {
  const recentList = recentPosts
    .slice(0, 12)
    .map((p) => `- ${p.title}${p.excerpt ? ` — ${p.excerpt}` : ''}`)
    .join('\n');

  const tagLine = knownTags.length
    ? `Pick 1-2 tags (never more than 2) from this existing taxonomy when they fit (do NOT invent new tags unless none fit): ${knownTags.join(' · ')}`
    : `Pick 1-2 tags (never more than 2) that fit the brand voice.`;

  return [
    `## Target question`,
    question,
    target_keyword ? `\n## Primary keyword to rank for\n${target_keyword}` : '',
    '',
    expertContext ? `## ⭐ EXPERT INTERVIEW — highest priority source\n${expertContext}` : null,
    '',
    '## Brand voice doc',
    brandVoice,
    '',
    '## AEO playbook',
    aeoPlaybook,
    '',
    '## Tag taxonomy',
    tagLine,
    '',
    '## Recently published posts (do NOT repeat the same argument)',
    recentList || '(none yet)',
    '',
    expertContext
      ? 'Write the article now. The expert interview above is your primary source — use the operator\'s specific language, frameworks, and examples. Output ONLY the JSON object.'
      : 'Write the article now. Output ONLY the JSON object specified in the system prompt.',
  ].filter(Boolean).join('\n');
}

// A hand-written draft is fed to the writer as "expert context": the operator's
// arguments are the source of truth, the writer only re-voices and re-formats.
const HANDDRAFT_PREAMBLE = 'The operator hand-drafted the article below. Treat it as the definitive source — keep its specific arguments, examples, structure, and point of view — but rewrite it to the brand voice and playbook, cut every banned phrase and any hollow authority-building filler, and shape it into clean semantic HTML.';

// ─── granular steps (v2) ────────────────────────────────────────────────────

// The assembled voice the writers follow: brand voice + the operator's learned
// editorial taste + the founder's personal voice when an article opts into it.
export async function readVoiceProfile(api, { voice = 'house' } = {}) {
  const brand = await api.knowledge('plugin-editorial-brand-voice');
  if (!brand?.body) throw new Error('knowledge doc brand-voice missing');
  let voice_doc = brand.body;
  try {
    const taste = await readTasteProfile(api);
    if (taste) voice_doc += `\n\n## Operator's learned editorial taste (honor this)\n${taste}`;
  } catch { /* taste profile is an enrichment, never a blocker */ }
  if (voice === 'personal') {
    const personalDoc = await api.knowledge('plugin-editorial-personal-voice').catch(() => null);
    if (personalDoc?.body) voice_doc += `\n\n## WRITE IN THE OPERATOR'S PERSONAL VOICE (this article opted in)\n${personalDoc.body}`;
  }
  return { voice_doc, voice };
}

// One LLM step: the article itself. Reads the playbook, dedups against the
// titles it is handed, and writes nothing to the database.
export async function draftArticle(api, {
  title = null, body = null, source_text = null, post = null,
  voice_doc = null, posts = null, target_keyword = null, expert_context = null, tags = null,
} = {}) {
  const playbookDoc = await api.knowledge('plugin-editorial-article-playbook');
  if (!playbookDoc?.body) throw new Error('knowledge doc article-playbook missing');

  const brandVoice = voice_doc || (await readVoiceProfile(api)).voice_doc;
  const recentPosts = Array.isArray(posts) ? posts : await listBlogPostRows(api, { limit: 200, publishedOnly: true });
  const knownTags = collectKnownTags(recentPosts);

  const seed = String(body || source_text || post?.content || '').trim();
  const heading = String(title || post?.title || seed.split(/[.\n]/)[0] || '').trim().slice(0, 120) || 'Untitled draft';
  const context = expert_context || (seed ? `${HANDDRAFT_PREAMBLE}\n\n---\n${seed}\n---` : null);

  const prompt = buildUserPrompt({
    question: heading,
    target_keyword,
    brandVoice,
    aeoPlaybook: playbookDoc.body,
    recentPosts,
    knownTags,
    expertContext: context,
  });

  const draft = await api.gateway('llm', 'json', { system: SYSTEM_PROMPT, prompt, heavy: true });
  if (!draft.slug || !draft.title || !draft.excerpt || !draft.body_html) {
    throw new Error(`writer returned a bad draft (keys: ${Object.keys(draft).join(',')})`);
  }
  const finalTags = (Array.isArray(draft.tags) && draft.tags.length
    ? draft.tags
    : (Array.isArray(tags) ? tags : [])).slice(0, 2); // guideline: max 2 tags per post

  return {
    article: {
      slug:      String(draft.slug).trim().toLowerCase(),
      title:     draft.title,
      excerpt:   draft.excerpt,
      body_html: draft.body_html,
      tags:      finalTags,
    },
  };
}

// Persist one drafted article. THE DRAFT GATE: a save never publishes. A new
// row lands published=0, and an existing row keeps the publication state it
// already has. Flipping published=1 is publish_blog_post's job alone.
export async function saveBlogPost(api, { article = null, slug = null, blog_slug = null, published_at = null, actor = 'system' } = {}) {
  if (!article || typeof article !== 'object') throw new Error('save_blog_post: article required');
  const target = String(slug || blog_slug || article.slug || '').trim().toLowerCase();
  if (!target) throw new Error('save_blog_post: no slug on the article and none supplied');

  const explicit = !!(slug || blog_slug);
  const existing = await readBlogPostRow(api, target);
  // An explicit slug means "this post" (reshape in place); an LLM-minted slug
  // must never silently overwrite a different article.
  const finalSlug = explicit || !existing ? target : await ensureUniqueSlug(api, target);
  const current = explicit ? existing : (finalSlug === target ? existing : null);

  let curTags = current?.tags;
  if (typeof curTags === 'string') { try { curTags = JSON.parse(curTags); } catch { curTags = []; } }

  await writeBlogPostRow(api, {
    slug:         finalSlug,
    title:        article.title   || current?.title   || 'Untitled',
    excerpt:      article.excerpt || current?.excerpt || null,
    body:         article.body_html || article.body || current?.body || '',
    tags:         Array.isArray(article.tags) && article.tags.length ? article.tags : (Array.isArray(curTags) ? curTags : []),
    published:    !!current?.published,
    published_at: current ? current.published_at : (published_at ?? null),
    updated_by:   actor,
  });

  // Read back before reporting success: a write we cannot read back is a
  // failed write, and Nyo must never claim a draft exists when it doesn't.
  const saved = await readBlogPostRow(api, finalSlug);
  if (!saved) throw new Error(`blog post ${finalSlug} did not persist — nothing was saved`);

  return {
    blog_slug: finalSlug,
    post:      saved,
    title:     saved.title,
    excerpt:   saved.excerpt,
    body:      saved.body,
    tags:      saved.tags,
  };
}

// One LLM step: lengthen an existing article and write its FAQ. No writes —
// save_blog_post + append_faq_schema persist what this returns.
export async function expandArticle(api, { post = null, slug = null, blog_slug = null, voice_doc = null } = {}) {
  const target = post || await readBlogPostRow(api, String(slug || blog_slug || ''));
  if (!target) throw new Error('expand_article: post (or a slug that resolves to one) required');

  const voice = voice_doc || (await readVoiceProfile(api, { voice: 'personal' })).voice_doc;
  const prompt = [
    '## Current article title', target.title, '',
    '## Current article body (HTML)', target.body || '', '',
    '## Brand voice + operator taste', voice, '',
    'Expand and upgrade this article per the system instructions. Output ONLY the JSON object.',
  ].join('\n');

  const out = await api.gateway('llm', 'json', { system: EXPAND_SYSTEM, prompt, heavy: true });
  if (!out.body_html) throw new Error(`expand returned no body_html (keys: ${Object.keys(out).join(',')})`);
  const faq = Array.isArray(out.faq) ? out.faq.filter((f) => f?.q && f?.a) : [];

  return {
    article: { excerpt: out.excerpt || target.excerpt, body_html: out.body_html, faq },
    faq, // top-level too: append_faq_schema reads it straight off the shared context
  };
}

// Append the FAQPage JSON-LD block for an already-saved FAQ. Separate from the
// expand step so a schema failure can never cost us the expanded prose.
export async function appendFaqSchema(api, { blog_slug = null, slug = null, faq = null } = {}) {
  const target = String(blog_slug || slug || '');
  const items = Array.isArray(faq) ? faq.filter((f) => f?.q && f?.a) : [];
  if (!target) throw new Error('append_faq_schema: blog_slug required');
  if (!items.length) return { ok: true, faq_count: 0, note: 'no FAQ items to append' };

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({
      '@type': 'Question',
      name: String(f.q),
      acceptedAnswer: { '@type': 'Answer', text: String(f.a) },
    })),
  };
  const cur = await readBlogPostRow(api, target);
  if (!cur) throw new Error(`append_faq_schema: blog post not found: ${target}`);
  await patchBlogPostRow(api, target, {
    body: `${cur.body || ''}\n<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
  });
  await api.log('blog_faq_schema_appended', { slug: target, faq_count: items.length });
  return { ok: true, faq_count: items.length };
}

// THE NO-DUPLICATE-WRITE GATE. The compare-and-set below is ONE statement on
// purpose: only the run that flips pending → drafting owns the question, so
// concurrent fires can never write the same article three times. Fail-closed.
export async function claimAeoQuestion(api, { question_slug = null, slug = null } = {}) {
  const wanted = question_slug || slug || null;
  const q = wanted ? await readAeoQuestionRow(api, wanted) : await nextScheduledReadyAeoQuestionRow(api);
  if (!q) throw new Error(wanted ? `AEO question not found: ${wanted}` : 'no ready question is due');

  // The mandatory interview gate: nothing is written until the operator's
  // answers exist. Un-interviewed questions belong in aeo-interview-start.
  let ctx = {};
  try { ctx = JSON.parse(q.expert_context_json || '{}'); } catch { /* treat as empty */ }
  if (q.interview_status !== 'ready' || !ctx?.answers) {
    throw new Error(`AEO question ${q.slug} has no interview answers yet — run aeo-interview-start first`);
  }

  const claim = await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET status='drafting', updated_at=? WHERE slug=? AND status IN ('pending','failed')`,
  ).bind(now(), q.slug).run();
  if (!claim?.meta?.changes) throw new Error(`AEO question ${q.slug} is already claimed (status ${q.status})`);

  await api.log('aeo_question_claimed', { question_slug: q.slug });
  return { question_slug: q.slug, claimed: true };
}

// Shape a hand-written draft into a house-style article and save it — the SAME
// craft the AEO pipeline gives every other post. Does NOT touch the AEO
// question queue and does NOT publish — the operator approves in the Blog
// module. Pass an existing `slug` to reshape in place.
export async function composeAndSavePost(api, {
  slug = null, title, body, excerpt = null, tags = null,
  target_keyword = null, voice = 'house', published = false, published_at = null,
  actor = 'nyo',
} = {}) {
  if (!title && !body) throw new Error('composeAndSavePost: title or body required');
  const startedAt = now();

  const [brandVoiceDoc, playbookDoc] = await Promise.all([
    api.knowledge('plugin-editorial-brand-voice'),
    api.knowledge('plugin-editorial-article-playbook'),
  ]);
  if (!brandVoiceDoc?.body) throw new Error('knowledge doc brand-voice missing');
  if (!playbookDoc?.body)   throw new Error('knowledge doc article-playbook missing');

  const recentPosts = await listBlogPostRows(api, { limit: 200, publishedOnly: true });
  const knownTags   = collectKnownTags(recentPosts);

  // Fold in the operator's learned editorial taste — this is what kills the
  // fluff and the fake-authority clichés on top of the banned-phrase list.
  let brandVoiceWithTaste = brandVoiceDoc.body;
  try {
    const taste = await readTasteProfile(api);
    if (taste) brandVoiceWithTaste += `\n\n## Operator's learned editorial taste (honor this)\n${taste}`;
  } catch { /* taste profile optional */ }
  if (voice === 'personal') {
    const personalDoc = await api.knowledge('plugin-editorial-personal-voice').catch(() => null);
    if (personalDoc?.body) brandVoiceWithTaste += `\n\n## WRITE IN THE OPERATOR'S PERSONAL VOICE (this article opted in)\n${personalDoc.body}`;
  }

  const expertContext = (body && body.trim())
    ? `${HANDDRAFT_PREAMBLE}\n\n---\n${body}\n---`
    : null;

  const prompt = buildUserPrompt({
    question: title || 'Untitled draft',
    target_keyword,
    brandVoice: brandVoiceWithTaste,
    aeoPlaybook: playbookDoc.body,
    recentPosts,
    knownTags,
    expertContext,
  });

  const draft = await api.gateway('llm', 'json', { system: SYSTEM_PROMPT, prompt, heavy: true });
  if (!draft.slug || !draft.title || !draft.excerpt || !draft.body_html) {
    throw new Error(`shaper returned a bad draft (keys: ${Object.keys(draft).join(',')})`);
  }
  if (!Array.isArray(draft.tags) || !draft.tags.length) {
    draft.tags = Array.isArray(tags) ? tags : [];
  }
  draft.tags = (Array.isArray(draft.tags) ? draft.tags : []).slice(0, 2); // guideline: max 2 tags per post

  // Honor an explicit slug (reshape in place); otherwise mint a fresh, unique one.
  const finalSlug = slug
    ? String(slug).trim().toLowerCase()
    : await ensureUniqueSlug(api, String(draft.slug).trim().toLowerCase());

  await writeBlogPostRow(api, {
    slug:         finalSlug,
    title:        title || draft.title,
    excerpt:      excerpt || draft.excerpt,
    body:         draft.body_html,
    tags:         draft.tags,
    published_at: published ? (published_at || Date.now()) : null,
    published:    !!published,
    updated_by:   actor,
  });

  // Read back before claiming success. A write we cannot read back is a
  // failed write.
  const saved = await readBlogPostRow(api, finalSlug);
  if (!saved) {
    await logRun(api, {
      workflow_slug: 'blog-shape',
      status: 'failed',
      trigger_kind: actor === 'nyo' ? 'nyo' : 'manual',
      output: { slug: finalSlug, error: 'post not readable after write' },
      started_at: startedAt,
    });
    throw new Error(`blog post ${finalSlug} did not persist — nothing was saved, do not tell the operator it was`);
  }
  await logRun(api, {
    workflow_slug: 'blog-shape',
    status: 'succeeded',
    trigger_kind: actor === 'nyo' ? 'nyo' : 'manual',
    output: { slug: finalSlug, title: saved?.title, voice },
    started_at: startedAt,
  });
  return {
    ok:             true,
    slug:           finalSlug,
    title:          saved?.title || title || draft.title,
    published:      !!published,
    post:           saved,
  };
}

// Expand + upgrade an existing post: deepen the story, weave in the company's
// upside substantively, and append an AEO-optimised FAQ (+ FAQPage JSON-LD).
const EXPAND_SYSTEM = `You are expanding and upgrading an existing blog post for the operator's company.

You receive the current article, plus the company's brand voice doc and the operator's learned editorial taste. The brand voice doc is the source of truth for who the company is, what it does, and how it positions itself — ground every company mention in it.

Do all of this:
1. Keep the thesis, structure, and best lines. Do not discard what works.
2. EXPAND the story to ~1,600-2,200 words: add depth and concrete detail, one or two real examples, the relevant history and naming, the failure modes, and the "why now".
3. Weave in the company's upside SUBSTANTIVELY, never as a pitch: two earned mentions inside the argument plus a short, plain closing, both grounded in the brand voice doc's positioning. No hype, no fake authority, no "we are the best".
4. Add an AEO-optimised FAQ at the very end: 6-8 natural-language questions a reader would actually ask an AI assistant about this topic. Each answer must be SELF-CONTAINED: 40-75 words that fully answer the question on its own so an answer engine can lift it verbatim. Position the company where it is the honest answer.

Return ONE JSON object, no prose, no code fence:
  excerpt:   string, <=155 chars, declarative
  body_html: string. Full expanded article as clean HTML using ONLY <p>, <h2>, <h3>, <strong>, <ul>, <li>, <blockquote>. Render the FAQ as: <h2>Frequently asked questions</h2> then one <h3>question</h3><p>answer</p> per item.
  faq:       array of { "q": string, "a": string } mirroring the FAQ exactly (for schema).

Hard rules: no em-dashes or en-dashes (use hyphens or restructure). No emoji, no exclamation marks. Banned phrases: revolutionary, game-changing, disruptive, next-gen, cutting-edge, world-class, leverage (as a verb), synergy, unlock, in today's world, dive in, in conclusion. Verbs over adjectives. Lead each section with its point.`;

export async function expandPostWithFaq(api, { slug, voice = 'personal', actor = 'operator' } = {}) {
  const startedAt = now();
  const post = await readBlogPostRow(api, slug);
  if (!post) throw new Error(`post ${slug} not found`);

  const brandVoiceDoc = await api.knowledge('plugin-editorial-brand-voice');
  let voiceDoc = brandVoiceDoc?.body || '';
  try {
    const taste = await readTasteProfile(api);
    if (taste) voiceDoc += `\n\n## Operator's learned editorial taste (honor this)\n${taste}`;
  } catch { /* taste optional */ }
  if (voice === 'personal') {
    const personalDoc = await api.knowledge('plugin-editorial-personal-voice').catch(() => null);
    if (personalDoc?.body) voiceDoc += `\n\n## WRITE IN THE OPERATOR'S PERSONAL VOICE\n${personalDoc.body}`;
  }

  const prompt = [
    '## Current article title', post.title, '',
    '## Current article body (HTML)', post.body || '', '',
    '## Brand voice + operator taste', voiceDoc, '',
    'Expand and upgrade this article per the system instructions. Output ONLY the JSON object.',
  ].join('\n');

  const out = await api.gateway('llm', 'json', { system: EXPAND_SYSTEM, prompt, heavy: true });
  if (!out.body_html) throw new Error(`expand returned no body_html (keys: ${Object.keys(out).join(',')})`);

  let tags = post.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = []; } }

  // 1. Save the expanded prose.
  await writeBlogPostRow(api, {
    slug,
    title:        post.title,
    excerpt:      out.excerpt || post.excerpt,
    body:         out.body_html,
    tags:         Array.isArray(tags) ? tags : [],
    published:    post.published === 1 || post.published === true,
    published_at: post.published_at || Date.now(),
    updated_by:   actor,
  });

  // 2. Append FAQPage JSON-LD (best-effort schema) so answer engines get
  //    structured Q&A. patchBlogPostRow merges, so it won't disturb tags.
  const faq = Array.isArray(out.faq) ? out.faq.filter((f) => f?.q && f?.a) : [];
  if (faq.length) {
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map((f) => ({
        '@type': 'Question',
        name: String(f.q),
        acceptedAnswer: { '@type': 'Answer', text: String(f.a) },
      })),
    };
    const cur = await readBlogPostRow(api, slug);
    await patchBlogPostRow(api, slug, {
      body: `${cur.body}\n<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
    });
  }

  const saved = await readBlogPostRow(api, slug);
  const words = (out.body_html.replace(/<[^>]+>/g, ' ').match(/\S+/g) || []).length;
  await logRun(api, {
    workflow_slug: 'blog-expand',
    status: 'succeeded',
    trigger_kind: actor === 'nyo' ? 'nyo' : 'manual',
    output: { slug, words, faq_count: faq.length },
    started_at: startedAt,
  });
  return { ok: true, slug, words, faq_count: faq.length };
}

// Write a specific question by slug (used by the interview flow, after the
// operator's answers are saved). Targets THAT question directly.
export async function runAeoCronForSlug(api, { slug, actor = 'nyo-interview' } = {}) {
  if (!slug) throw new Error('runAeoCronForSlug: slug required');
  const t = now();
  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET status='pending', last_error=NULL, updated_at=? WHERE slug=?`,
  ).bind(t, slug).run();
  return runAeoCron(api, { actor, targetSlug: slug });
}

// Drafts a single article. Returns { ok, blog_slug, question_slug } or
// { ok: false, error }. Never throws — caller can rely on the shape.
// `targetSlug` (optional) writes a specific question instead of next-in-queue.
export async function runAeoCron(api, { actor = 'aeo-cron', targetSlug = null, readyOnly = false } = {}) {
  const startedAt = now();
  const q = targetSlug
    ? await readAeoQuestionRow(api, targetSlug)
    : (readyOnly ? await nextScheduledReadyAeoQuestionRow(api) : await nextPendingAeoQuestionRow(api));
  // Autonomous (readyOnly) run with nothing ready + due → quiet no-op. Still
  // leaves a run record — the trail should show it ran.
  if (readyOnly && !q) {
    await logRun(api, {
      workflow_slug: 'aeo-daily-writer',
      status: 'succeeded',
      trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
      output: { published: false, reason: 'no scheduled article due' },
      started_at: startedAt,
    });
    return { ok: true, published: false, reason: 'no scheduled article due' };
  }
  if (!q) {
    await logRun(api, {
      workflow_slug: 'aeo-daily-writer',
      status: 'succeeded',
      trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
      output: { skipped: true, reason: 'no pending questions' },
      started_at: startedAt,
    });
    return { ok: false, error: 'no pending questions' };
  }

  // CLAIM the question atomically — flip pending → drafting only if it's
  // still pending. Concurrent fires bail on changes===0 (the fix for the
  // 3-copies-in-3-seconds bug).
  const claim = await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET status='drafting', updated_at=? WHERE slug=? AND status='pending'`,
  ).bind(now(), q.slug).run();
  if (!claim?.meta?.changes) {
    return { ok: false, error: 'question already claimed by a concurrent run', question_slug: q.slug };
  }

  // ─── MANDATORY INTERVIEW GATE ───────────────────────────────────────────
  // No article is written until the operator has answered an interview about
  // it. If this question has no answers yet, START the interview: generate
  // questions, save them, surface the ask, release the claim.
  const freshForGate = await readAeoQuestionRow(api, q.slug);
  let gateCtx = {};
  try { gateCtx = JSON.parse(freshForGate?.expert_context_json || '{}'); } catch { /* empty */ }
  const hasAnswers = freshForGate?.interview_status === 'ready' && gateCtx?.answers;

  if (!hasAnswers) {
    try {
      const questions = await generateInterviewQuestionsInline(api, {
        question: q.question, target_keyword: q.target_keyword, notes: q.notes,
      });
      await saveInterviewQuestionsInline(api, q.slug, questions); // sets interview_status='pending'
      // Release the draft claim so the row isn't stuck in 'drafting'.
      await api.db.prepare(`UPDATE plugin_editorial_aeo_questions SET status='pending', updated_at=? WHERE slug=?`).bind(now(), q.slug).run();

      const qList = questions.map((qq, i) => `${i + 1}. ${qq}`).join('\n');
      const nyo = await queueNyoNotice(api, {
        kind:    'aeo_interview_request',
        ref_kind: 'aeo_questions',
        ref_id:  q.slug,
        content:
          `✍️ **Before I write the next article, I need your take.**\n\n` +
          `Topic: **${q.question}**\n\n` +
          `${qList}\n\n` +
          `Answer these (one message is fine) and I'll write it around your expertise, then publish. ` +
          `Nothing goes live until you've weighed in.\n\n` +
          `_When you reply, I'll call \`aeo_write_with_answers\` with slug \`${q.slug}\`._`,
        payload: { question_slug: q.slug, questions },
      });
      await logRun(api, {
        workflow_slug: 'aeo-daily-writer',
        status: 'succeeded',
        trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
        output: { interview_started: true, question_slug: q.slug, questions },
        started_at: startedAt,
      });
      return { ok: false, reason: 'interview_required', interview_started: true, question_slug: q.slug, questions, nyo_message: nyo.content };
    } catch (e) {
      // If the interview kickoff fails, release the claim so it can retry.
      await api.db.prepare(`UPDATE plugin_editorial_aeo_questions SET status='pending', updated_at=? WHERE slug=?`).bind(now(), q.slug).run();
      return { ok: false, error: `interview kickoff failed: ${String(e?.message || e)}`, question_slug: q.slug };
    }
  }

  try {
    const [brandVoiceDoc, playbookDoc] = await Promise.all([
      api.knowledge('plugin-editorial-brand-voice'),
      api.knowledge('plugin-editorial-article-playbook'),
    ]);
    if (!brandVoiceDoc?.body)  throw new Error('knowledge doc brand-voice missing');
    if (!playbookDoc?.body)    throw new Error('knowledge doc article-playbook missing');

    // Pull a wider recent window for dedup + the existing tag taxonomy.
    const recentPosts = await listBlogPostRows(api, { limit: 200, publishedOnly: true });
    const knownTags   = collectKnownTags(recentPosts);

    // Re-read the question to get expert_context_json (may have been added
    // after the initial queue pick, e.g. via the interview flow).
    const freshQ        = await readAeoQuestionRow(api, q.slug);
    const expertContext = formatExpertContext(freshQ?.expert_context_json || null);

    // Editorial taste — learned from the operator's reactions.
    let taste = null;
    try { taste = await readTasteProfile(api); } catch { /* optional */ }
    let brandVoiceWithTaste = taste
      ? `${brandVoiceDoc.body}\n\n## Operator's learned editorial taste (honor this)\n${taste}`
      : brandVoiceDoc.body;

    // Optional per-article voice: 'personal' layers the founder's personal
    // voice on top of the house voice.
    if (freshQ?.voice === 'personal') {
      const personalDoc = await api.knowledge('plugin-editorial-personal-voice').catch(() => null);
      if (personalDoc?.body) brandVoiceWithTaste += `\n\n## WRITE IN THE OPERATOR'S PERSONAL VOICE (this article opted in)\n${personalDoc.body}`;
    }

    const prompt = buildUserPrompt({
      question:       q.question,
      target_keyword: q.target_keyword,
      brandVoice:     brandVoiceWithTaste,
      aeoPlaybook:    playbookDoc.body,
      recentPosts,
      knownTags,
      expertContext,
    });

    const draft = await api.gateway('llm', 'json', { system: SYSTEM_PROMPT, prompt, heavy: true });

    // Sanity-check the draft. Bad shape -> mark failed, don't publish.
    if (!draft.slug || !draft.title || !draft.excerpt || !draft.body_html) {
      throw new Error(`draft missing required fields: ${Object.keys(draft).join(',')}`);
    }
    if (!Array.isArray(draft.tags)) draft.tags = [];

    // Title-collision guard — if a published post already has this exact
    // title, don't create a near-dup with a -2/-3 slug.
    const titleNorm = String(draft.title).trim().toLowerCase();
    const existingByTitle = recentPosts.find((p) => String(p.title || '').trim().toLowerCase() === titleNorm);
    if (existingByTitle) {
      await markAeoQuestionPublishedRow(api, q.slug, existingByTitle.slug);
      await logRun(api, {
        workflow_slug: 'aeo-daily-writer',
        status: 'succeeded',
        trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
        output: { skipped: true, reason: 'title already published', existing_slug: existingByTitle.slug, question_slug: q.slug },
        started_at: startedAt,
      });
      return { ok: false, error: 'title already published', question_slug: q.slug, blog_slug: existingByTitle.slug };
    }

    // Avoid silently overwriting an existing blog post that happens to share
    // the LLM-picked slug.
    const safeSlug = await ensureUniqueSlug(api, String(draft.slug).trim().toLowerCase());

    // Outbox row — treats a blog publish like any other outbound send so it
    // shows up in the unified Outbox surface. If the write fails the row stays
    // `failed`; the wake-up summary surfaces it.
    const outboxRow = await api.gateway('outbox', 'begin', {
      channel:    'blog',
      kind:       'publish',
      to_id:      safeSlug,
      to_name:    draft.title,
      body:       draft.excerpt || '',
      payload:    { question_slug: q.slug, slug: safeSlug, target_keyword: q.target_keyword, tags: draft.tags },
      source:     actor === 'aeo-cron' ? 'cron' : 'operator',
      source_ref: q.slug,
    });

    // Save as a DRAFT (published=0). The operator approves it in the Blog
    // module → "Needs review", which publishes. published_at stays null until
    // approval stamps it.
    try {
      await writeBlogPostRow(api, {
        slug:         safeSlug,
        title:        draft.title,
        excerpt:      draft.excerpt,
        body:         draft.body_html,
        tags:         draft.tags,
        published_at: null,
        published:    false,
        updated_by:   actor,
      });
      await api.gateway('outbox', 'sent', { id: outboxRow.id, message_id: safeSlug });
    } catch (writeErr) {
      await api.gateway('outbox', 'failed', { id: outboxRow.id, error: String(writeErr?.message || writeErr) });
      throw writeErr;
    }

    await markAeoQuestionDraftedRow(api, q.slug, safeSlug);

    // The writer no longer deploys: posts are drafts now. The operator
    // approves in the Blog module → "Needs review", and THAT publishes.
    const deploy = { ok: false, reason: 'draft — awaiting your approval in the Blog module' };

    await logRun(api, {
      workflow_slug: 'aeo-daily-writer',
      status: 'succeeded',
      trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
      trigger_payload: { question_slug: q.slug, target_keyword: q.target_keyword },
      output: { blog_slug: safeSlug, title: draft.title, tags: draft.tags, word_count: draft.body_html.split(/\s+/).length, deployed: deploy.ok, deploy_reason: deploy.reason || null },
      started_at: startedAt,
    });

    // Tell Nyo what just happened (activity-bus notice; content also returned).
    const wc = draft.body_html.split(/\s+/).length;
    const tagsLine = Array.isArray(draft.tags) && draft.tags.length ? ` Tagged ${draft.tags.slice(0, 3).join(', ')}.` : '';
    const trigger  = actor === 'aeo-cron' ? 'the daily cron' : `you (${actor})`;
    const liveLine = `Triggered by ${trigger}. It's saved as a **draft** — open the **Blog** module → **Needs review** to read it and approve. Approving publishes it to your public site.`;
    const nyo = await queueNyoNotice(api, {
      kind:     'aeo_drafted',
      ref_kind: 'blog_posts',
      ref_id:   safeSlug,
      content:
        `📝 **Drafted a new article for your review.**\n\n` +
        `**"${draft.title}"**, answering the AEO question \`${q.slug}\`. ${wc} words.${tagsLine}\n\n` +
        `${liveLine}`,
      payload: { blog_slug: safeSlug, question_slug: q.slug, title: draft.title, word_count: wc, deployed: false, status: 'draft' },
    });

    return { ok: true, question_slug: q.slug, blog_slug: safeSlug, title: draft.title, deployed: deploy.ok, deploy_reason: deploy.reason || null, nyo_message: nyo.content };
  } catch (e) {
    const msg = e?.message || String(e);
    // Main model out of credit → PAUSE, don't fail. Release the claim back to
    // pending so a later cron picks the question up again.
    if (e?.llmDown) {
      await api.db.prepare(`UPDATE plugin_editorial_aeo_questions SET status='pending', updated_at=? WHERE slug=?`).bind(now(), q.slug).run();
      await logRun(api, {
        workflow_slug: 'aeo-daily-writer',
        status: 'skipped',
        trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
        trigger_payload: { question_slug: q.slug },
        output: { paused: true, reason: 'primary LLM out of credit — article writing paused until topped up' },
        started_at: startedAt,
      });
      return { ok: false, paused: true, reason: 'llm_out_of_credit', question_slug: q.slug };
    }
    await markAeoQuestionFailedRow(api, q.slug, msg);
    await logRun(api, {
      workflow_slug: 'aeo-daily-writer',
      status: 'failed',
      trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
      trigger_payload: { question_slug: q.slug },
      error: msg,
      started_at: startedAt,
    });
    // Notify about the failure too.
    const nyo = await queueNyoNotice(api, {
      kind:     'aeo_failed',
      ref_kind: 'aeo_questions',
      ref_id:   q.slug,
      content:
        `⚠️ **AEO writer failed.**\n\n` +
        `Tried to draft \`${q.slug}\` and hit: ${msg}\n\n` +
        `The question stays in the queue so you can retry. Ask me to look at it.`,
      payload: { question_slug: q.slug, error: msg },
    });
    return { ok: false, error: msg, question_slug: q.slug, nyo_message: nyo.content };
  }
}
