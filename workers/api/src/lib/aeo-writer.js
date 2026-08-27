// AEO writer: pulls the next pending question, drafts an article in the
// brand voice via OpenAI, and publishes it directly to blog_posts. Fired by the
// daily cron AND by the manual "draft now" button in the AEO ops page.

import {
  nextPendingAeoQuestion, nextScheduledReadyAeoQuestion, markAeoQuestionPublished, markAeoQuestionDrafted, markAeoQuestionFailed,
  readAeoQuestion, readKnowledge, readBlogPost, listBlogPosts, writeBlogPost, patchBlogPost,
  logWorkflowRun, queueNyoMessage, logEvent,
} from './db.js';
import { formatExpertContext } from './aeo-interview.js';
import { beginSend, markSent, markFailed } from './outbox.js';
import { callOpenAIJson } from './openai.js';
import { generateBlogFeaturedImage } from './blog-images.js';
import { now } from './util.js';

// Walk slug-1, slug-2, … until we find one that doesn't collide with an
// existing blog_posts row. Cron picks one question per day, so 50 tries is
// far more headroom than we'll ever need.
async function ensureUniqueSlug(env, candidate) {
  if (!(await readBlogPost(env, candidate))) return candidate;
  for (let i = 2; i <= 50; i++) {
    const next = `${candidate}-${i}`;
    if (!(await readBlogPost(env, next))) return next;
  }
  throw new Error(`could not find a free slug starting from ${candidate}`);
}

// Pull a deduped list of tags from already-published posts. We pass this into
// the LLM so it sticks to the site's existing taxonomy instead of inventing new ones.
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

// ─── granular steps (v2) ─────────────────────────────────────────────────────
// The narrow halves of composeAndSavePost, each doing ONE job so a workflow can
// order them: read the voice, draft, save. They share the prompt constants and
// helpers above with the fat functions below, which still work unchanged.

// A hand-written draft is fed to the writer as "expert context": the operator's
// arguments are the source of truth, the writer only re-voices and re-formats.
const HANDDRAFT_PREAMBLE = 'The operator hand-drafted the article below. Treat it as the definitive source — keep its specific arguments, examples, structure, and point of view — but rewrite it to the brand voice and playbook, cut every banned phrase and any hollow authority-building filler, and shape it into clean semantic HTML.';

// The assembled voice the writers follow: brand voice + the operator's learned
// editorial taste (what kills the fluff) + the founder's personal voice when an
// article opts into it.
export async function readVoiceProfile(env, { voice = 'house' } = {}) {
  const brand = await readKnowledge(env, 'brand-voice');
  if (!brand?.body) throw new Error('knowledge doc brand-voice missing');
  let voice_doc = brand.body;
  try {
    const { readTasteProfile } = await import('./aeo-taste.js');
    const taste = await readTasteProfile(env);
    if (taste) voice_doc += `\n\n## Operator's learned editorial taste (honor this)\n${taste}`;
  } catch { /* taste profile is an enrichment, never a blocker */ }
  if (voice === 'personal') {
    const personalDoc = await readKnowledge(env, 'personal-voice').catch(() => null);
    if (personalDoc?.body) voice_doc += `\n\n## WRITE IN THE OPERATOR'S PERSONAL VOICE (this article opted in)\n${personalDoc.body}`;
  }
  return { voice_doc, voice };
}

// One LLM step: the article itself. Reads the playbook, dedups against the
// titles it is handed, and writes nothing to the database.
export async function draftArticle(env, {
  title = null, body = null, source_text = null, post = null,
  voice_doc = null, posts = null, target_keyword = null, expert_context = null, tags = null,
} = {}) {
  const playbookDoc = await readKnowledge(env, 'article-playbook');
  if (!playbookDoc?.body) throw new Error('knowledge doc article-playbook missing');

  const brandVoice = voice_doc || (await readVoiceProfile(env)).voice_doc;
  const recentPosts = Array.isArray(posts) ? posts : await listBlogPosts(env, { limit: 200, publishedOnly: true });
  const knownTags = collectKnownTags(recentPosts);

  // Seed text: an explicit draft body, or the content of whatever row the
  // previous step put in context (a social post being expanded into an article).
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

  const draft = await callOpenAIJson(env, { system: SYSTEM_PROMPT, prompt, heavy: true });
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
// already has, so reshaping a live article can neither unpublish it nor push a
// draft live. Flipping published=1 is publish_blog_post's job alone.
export async function saveBlogPost(env, { article = null, slug = null, blog_slug = null, published_at = null, actor = 'system' } = {}) {
  if (!article || typeof article !== 'object') throw new Error('save_blog_post: article required');
  const target = String(slug || blog_slug || article.slug || '').trim().toLowerCase();
  if (!target) throw new Error('save_blog_post: no slug on the article and none supplied');

  const explicit = !!(slug || blog_slug);
  const existing = await readBlogPost(env, target);
  // An explicit slug means "this post" (reshape in place); an LLM-minted slug
  // must never silently overwrite a different article.
  const finalSlug = explicit || !existing ? target : await ensureUniqueSlug(env, target);
  const current = explicit ? existing : (finalSlug === target ? existing : null);

  let curTags = current?.tags;
  if (typeof curTags === 'string') { try { curTags = JSON.parse(curTags); } catch { curTags = []; } }

  await writeBlogPost(env, {
    slug:         finalSlug,
    title:        article.title   || current?.title   || 'Untitled',
    excerpt:      article.excerpt || current?.excerpt || null,
    body:         article.body_html || article.body || current?.body || '',
    tags:         Array.isArray(article.tags) && article.tags.length ? article.tags : (Array.isArray(curTags) ? curTags : []),
    published:    !!current?.published,
    published_at: current ? current.published_at : (published_at ?? null),
    updated_by:   actor,
  });

  // Read back before reporting success: a write we cannot read back is a failed
  // write, and Nyo must never tell the operator a draft exists when it doesn't.
  const saved = await readBlogPost(env, finalSlug);
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
export async function expandArticle(env, { post = null, slug = null, blog_slug = null, voice_doc = null } = {}) {
  const target = post || await readBlogPost(env, String(slug || blog_slug || ''));
  if (!target) throw new Error('expand_article: post (or a slug that resolves to one) required');

  const voice = voice_doc || (await readVoiceProfile(env, { voice: 'personal' })).voice_doc;
  const prompt = [
    '## Current article title', target.title, '',
    '## Current article body (HTML)', target.body || '', '',
    '## Brand voice + operator taste', voice, '',
    'Expand and upgrade this article per the system instructions. Output ONLY the JSON object.',
  ].join('\n');

  const out = await callOpenAIJson(env, { system: EXPAND_SYSTEM, prompt, heavy: true });
  if (!out.body_html) throw new Error(`expand returned no body_html (keys: ${Object.keys(out).join(',')})`);
  const faq = Array.isArray(out.faq) ? out.faq.filter((f) => f?.q && f?.a) : [];

  return {
    article: { excerpt: out.excerpt || target.excerpt, body_html: out.body_html, faq },
    faq, // top-level too: append_faq_schema reads it straight off the shared context
  };
}

// Append the FAQPage JSON-LD block for an already-saved FAQ. Separate from the
// expand step so a schema failure can never cost us the expanded prose.
export async function appendFaqSchema(env, { blog_slug = null, slug = null, faq = null } = {}) {
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
  const cur = await readBlogPost(env, target);
  if (!cur) throw new Error(`append_faq_schema: blog post not found: ${target}`);
  await patchBlogPost(env, target, {
    body: `${cur.body || ''}\n<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
  });
  await logEvent(env, { kind: 'blog_faq_schema_appended', actor: 'system', payload: { slug: target, faq_count: items.length } });
  return { ok: true, faq_count: items.length };
}

// THE NO-DUPLICATE-WRITE GATE. The compare-and-set below is ONE statement on
// purpose: only the run that flips pending → drafting owns the question, so
// concurrent fires (cron + wake-up + a manual click) can never write the same
// article three times. Fail-closed: no claim, no article, and no auto-retry.
export async function claimAeoQuestion(env, { question_slug = null, slug = null } = {}) {
  const wanted = question_slug || slug || null;
  const q = wanted ? await readAeoQuestion(env, wanted) : await nextScheduledReadyAeoQuestion(env);
  if (!q) throw new Error(wanted ? `AEO question not found: ${wanted}` : 'no ready question is due');

  // The mandatory interview gate: nothing is written until the operator's
  // answers exist. Un-interviewed questions belong in aeo-interview-start.
  let ctx = {};
  try { ctx = JSON.parse(q.expert_context_json || '{}'); } catch { /* treat as empty */ }
  if (q.interview_status !== 'ready' || !ctx?.answers) {
    throw new Error(`AEO question ${q.slug} has no interview answers yet — run aeo-interview-start first`);
  }

  const claim = await env.DB.prepare(
    `UPDATE aeo_questions SET status='drafting', updated_at=? WHERE slug=? AND status IN ('pending','failed')`,
  ).bind(now(), q.slug).run();
  if (!claim?.meta?.changes) throw new Error(`AEO question ${q.slug} is already claimed (status ${q.status})`);

  await logEvent(env, { kind: 'aeo_question_claimed', actor: 'system', payload: { question_slug: q.slug } });
  return { question_slug: q.slug, claimed: true };
}

// Shape a hand-written draft into a house-style article and save it — the SAME
// craft the AEO pipeline gives every other post: the draft is rewritten to
// clean semantic HTML against the brand voice + the operator's learned editorial
// taste (which strips the banned phrases and hollow authority-building filler),
// then 2–5 editorial diagrams are generated and the first becomes the featured
// image. This is what the bare `write_blog_post` tool runs, so a hand-written
// post comes out shaped right instead of as a raw-markdown wall of text.
//
// It deliberately does NOT touch the AEO question queue and does NOT deploy —
// the caller publishes/deploys explicitly. Pass an existing `slug` to reshape
// that post in place; omit it to mint a fresh slug from the improved title.
export async function composeAndSavePost(env, {
  slug = null, title, body, excerpt = null, tags = null,
  target_keyword = null, voice = 'house', published = false, published_at = null,
  actor = 'nyo',
} = {}) {
  // published defaults to false: a fresh Nyo write lands as a DRAFT the operator
  // reviews + approves in the Blog module. Callers that reshape an existing post
  // pass its current published state explicitly, so this only gates NEW posts.
  if (!title && !body) throw new Error('composeAndSavePost: title or body required');
  const startedAt = now();

  const [brandVoiceDoc, playbookDoc] = await Promise.all([
    readKnowledge(env, 'brand-voice'),
    readKnowledge(env, 'article-playbook'),
  ]);
  if (!brandVoiceDoc?.body) throw new Error('knowledge doc brand-voice missing');
  if (!playbookDoc?.body)   throw new Error('knowledge doc article-playbook missing');

  const recentPosts = await listBlogPosts(env, { limit: 200, publishedOnly: true });
  const knownTags   = collectKnownTags(recentPosts);

  // Fold in the operator's learned editorial taste — this is what kills the
  // fluff and the fake-authority clichés on top of the banned-phrase list.
  let brandVoiceWithTaste = brandVoiceDoc.body;
  try {
    const { readTasteProfile } = await import('./aeo-taste.js');
    const taste = await readTasteProfile(env);
    if (taste) brandVoiceWithTaste += `\n\n## Operator's learned editorial taste (honor this)\n${taste}`;
  } catch { /* taste profile optional */ }
  if (voice === 'personal') {
    const personalDoc = await readKnowledge(env, 'personal-voice').catch(() => null);
    if (personalDoc?.body) brandVoiceWithTaste += `\n\n## WRITE IN THE OPERATOR'S PERSONAL VOICE (this article opted in)\n${personalDoc.body}`;
  }

  // The hand-written draft becomes the "expert interview" — the primary source
  // the writer must build around: keep the specific arguments + POV, drop the
  // filler, and emit clean HTML.
  const expertContext = (body && body.trim())
    ? `The operator hand-drafted the article below. Treat it as the definitive source — keep its specific arguments, examples, structure, and point of view — but rewrite it to the brand voice and playbook, cut every banned phrase and any hollow authority-building filler, and shape it into clean semantic HTML.\n\n---\n${body}\n---`
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

  const draft = await callOpenAIJson(env, { system: SYSTEM_PROMPT, prompt, heavy: true });
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
    : await ensureUniqueSlug(env, String(draft.slug).trim().toLowerCase());

  await writeBlogPost(env, {
    slug:         finalSlug,
    title:        title || draft.title,
    excerpt:      excerpt || draft.excerpt,
    body:         draft.body_html,
    tags:         draft.tags,
    published_at: published ? (published_at || Date.now()) : null,
    published:    !!published,
    updated_by:   actor,
  });

  // Figures (2–5 diagrams embedded, first = featured image) + AI-image fallback.
  // Best-effort: visuals never block the article from saving.
  let figures = null, image = null;
  try {
    const { generateArticleFigures } = await import('./article-figures.js');
    figures = await generateArticleFigures(env, { slug: finalSlug, actor, trigger_kind: 'manual' });
  } catch (e) { console.warn(`[compose-figures] ${finalSlug}:`, e?.message || e); }
  if (figures?.featured_url) {
    image = { url: figures.featured_url, model: 'article-figure' };
  } else {
    try {
      const img = await generateBlogFeaturedImage(env, {
        slug: finalSlug, title: title || draft.title, excerpt: excerpt || draft.excerpt, tags: draft.tags, actor,
      });
      image = { url: img.url, model: img.model };
    } catch (e) { console.warn(`[compose-image] ${finalSlug}:`, e?.message || e); }
  }

  // Read back before claiming success. Without this the function returned
  // ok:true with post:null whenever the write silently failed to land, and Nyo
  // reported "draft saved, in Needs review" for an article that did not exist.
  // A write we cannot read back is a failed write.
  const saved = await readBlogPost(env, finalSlug);
  if (!saved) {
    await logWorkflowRun(env, {
      workflow_slug: 'blog-shape',
      status: 'failed',
      trigger_kind: actor === 'nyo' ? 'nyo' : 'manual',
      output: { slug: finalSlug, error: 'post not readable after write' },
      started_at: startedAt,
    }).catch(() => {});
    throw new Error(`blog post ${finalSlug} did not persist — nothing was saved, do not tell the operator it was`);
  }
  await logWorkflowRun(env, {
    workflow_slug: 'blog-shape',
    status: 'succeeded',
    trigger_kind: actor === 'nyo' ? 'nyo' : 'manual',
    output: { slug: finalSlug, title: saved?.title, figures: !!figures, featured_image: image?.url || saved?.featured_image_url || null, voice },
    started_at: startedAt,
  }).catch(() => {});
  return {
    ok:             true,
    slug:           finalSlug,
    title:          saved?.title || title || draft.title,
    published:      !!published,
    featured_image: image?.url || saved?.featured_image_url || null,
    figures:        !!figures,
    post:           saved,
  };
}

// Expand + upgrade an existing post: deepen the story, weave in the company's
// upside substantively, and append an AEO-optimised FAQ (+ FAQPage JSON-LD schema).
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

export async function expandPostWithFaq(env, { slug, voice = 'personal', actor = 'operator' } = {}) {
  const startedAt = now();
  const post = await readBlogPost(env, slug);
  if (!post) throw new Error(`post ${slug} not found`);

  const brandVoiceDoc = await readKnowledge(env, 'brand-voice');
  let voiceDoc = brandVoiceDoc?.body || '';
  try {
    const { readTasteProfile } = await import('./aeo-taste.js');
    const taste = await readTasteProfile(env);
    if (taste) voiceDoc += `\n\n## Operator's learned editorial taste (honor this)\n${taste}`;
  } catch { /* taste optional */ }
  if (voice === 'personal') {
    const personalDoc = await readKnowledge(env, 'personal-voice').catch(() => null);
    if (personalDoc?.body) voiceDoc += `\n\n## WRITE IN THE OPERATOR'S PERSONAL VOICE\n${personalDoc.body}`;
  }

  const prompt = [
    '## Current article title', post.title, '',
    '## Current article body (HTML)', post.body || '', '',
    '## Brand voice + operator taste', voiceDoc, '',
    'Expand and upgrade this article per the system instructions. Output ONLY the JSON object.',
  ].join('\n');

  const out = await callOpenAIJson(env, { system: EXPAND_SYSTEM, prompt, heavy: true });
  if (!out.body_html) throw new Error(`expand returned no body_html (keys: ${Object.keys(out).join(',')})`);

  let tags = post.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = []; } }

  // 1. Save the expanded prose. writeBlogPost leaves featured_image_url intact.
  await writeBlogPost(env, {
    slug,
    title:        post.title,
    excerpt:      out.excerpt || post.excerpt,
    body:         out.body_html,
    tags:         Array.isArray(tags) ? tags : [],
    published:    post.published === 1 || post.published === true,
    published_at: post.published_at || Date.now(),
    updated_by:   actor,
  });

  // 2. Re-embed editorial figures + refresh the cover for the expanded content.
  let figures = null;
  try {
    const { generateArticleFigures } = await import('./article-figures.js');
    figures = await generateArticleFigures(env, { slug, actor, trigger_kind: 'manual' });
  } catch (e) { console.warn(`[expand-figures] ${slug}:`, e?.message || e); }

  // 3. Append FAQPage JSON-LD (best-effort schema) so answer engines get
  //    structured Q&A. patchBlogPost merges, so it won't disturb the cover/tags.
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
    const cur = await readBlogPost(env, slug);
    await patchBlogPost(env, slug, {
      body: `${cur.body}\n<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
    });
  }

  const saved = await readBlogPost(env, slug);
  const words = (out.body_html.replace(/<[^>]+>/g, ' ').match(/\S+/g) || []).length;
  await logWorkflowRun(env, {
    workflow_slug: 'blog-expand',
    status: 'succeeded',
    trigger_kind: actor === 'nyo' ? 'nyo' : 'manual',
    output: { slug, words, faq_count: faq.length, figures: !!figures, featured_image: saved?.featured_image_url || null },
    started_at: startedAt,
  }).catch(() => {});
  return { ok: true, slug, words, faq_count: faq.length, featured_image: saved?.featured_image_url || null, figures: !!figures };
}

// Write a specific question by slug (used by the interview flow, after the
// operator's answers are saved). Targets THAT question directly — not "next
// pending" — so answering question X writes question X, even if a
// higher-priority question is ahead of it in the queue.
export async function runAeoCronForSlug(env, { slug, actor = 'nyo-interview' } = {}) {
  if (!slug) throw new Error('runAeoCronForSlug: slug required');
  const t = now();
  await env.DB.prepare(
    `UPDATE aeo_questions SET status='pending', last_error=NULL, updated_at=? WHERE slug=?`
  ).bind(t, slug).run();
  return runAeoCron(env, { actor, targetSlug: slug });
}

// Drafts and publishes a single article. Returns { ok, blog_slug, question_slug }
// or { ok: false, error }. Never throws — caller can rely on the shape.
// `targetSlug` (optional) writes a specific question instead of next-in-queue.
export async function runAeoCron(env, { actor = 'aeo-cron', targetSlug = null, readyOnly = false } = {}) {
  const startedAt = now();
  const q = targetSlug
    ? await readAeoQuestion(env, targetSlug)
    : (readyOnly ? await nextScheduledReadyAeoQuestion(env) : await nextPendingAeoQuestion(env));
  // Autonomous (readyOnly) run with nothing ready + due → quiet no-op, never starts
  // an interview and never alarms the scheduler. Still leaves a run row — this
  // is the daily cron's most common outcome and the trail should show it ran.
  if (readyOnly && !q) {
    await logWorkflowRun(env, {
      workflow_slug: 'aeo-daily-writer',
      status: 'succeeded',
      trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
      output: { published: false, reason: 'no scheduled article due' },
      started_at: startedAt,
    }).catch(console.error);
    return { ok: true, published: false, reason: 'no scheduled article due' };
  }
  if (!q) {
    await logWorkflowRun(env, {
      workflow_slug: 'aeo-daily-writer',
      status: 'succeeded',
      trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
      output: { skipped: true, reason: 'no pending questions' },
      started_at: startedAt,
    });
    return { ok: false, error: 'no pending questions' };
  }

  // CLAIM the question atomically — flip pending → drafting only if it's still
  // pending. If another concurrent run already claimed it, changes===0 and we
  // bail. This is what stopped the 3-copies-in-3-seconds bug: rapid concurrent
  // fires (cron + wake-up + manual) used to all grab the same pending row.
  const claim = await env.DB.prepare(
    `UPDATE aeo_questions SET status='drafting', updated_at=? WHERE slug=? AND status='pending'`
  ).bind(now(), q.slug).run();
  if (!claim?.meta?.changes) {
    return { ok: false, error: 'question already claimed by a concurrent run', question_slug: q.slug };
  }

  // ─── MANDATORY INTERVIEW GATE ───────────────────────────────────────────
  // No article is written or published until the operator has answered an
  // interview about it. If this question has no answers yet, START the
  // interview: generate questions, save them, queue a Nyo message asking the
  // operator, release the claim (status back to 'pending', interview_status
  // 'pending' so the queue skips it until answers arrive). The article is
  // written later by aeo_write_with_answers → runAeoCronForSlug.
  const freshForGate = await readAeoQuestion(env, q.slug);
  let gateCtx = {};
  try { gateCtx = JSON.parse(freshForGate?.expert_context_json || '{}'); } catch {}
  const hasAnswers = freshForGate?.interview_status === 'ready' && gateCtx?.answers;

  if (!hasAnswers) {
    try {
      const { generateInterviewQuestions, saveInterviewQuestions } = await import('./aeo-interview.js');
      const questions = await generateInterviewQuestions(env, {
        slug: q.slug, question: q.question, target_keyword: q.target_keyword, notes: q.notes,
      });
      await saveInterviewQuestions(env, q.slug, questions); // sets interview_status='pending'
      // Release the draft claim so the row isn't stuck in 'drafting'.
      await env.DB.prepare(`UPDATE aeo_questions SET status='pending', updated_at=? WHERE slug=?`).bind(now(), q.slug).run();

      const qList = questions.map((qq, i) => `${i + 1}. ${qq}`).join('\n');
      await queueNyoMessage(env, {
        kind:    'aeo_interview_request',
        ref_kind:'aeo_questions',
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
      await logWorkflowRun(env, {
        workflow_slug: 'aeo-daily-writer',
        status: 'succeeded',
        trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
        output: { interview_started: true, question_slug: q.slug, questions },
        started_at: startedAt,
      });
      return { ok: false, reason: 'interview_required', interview_started: true, question_slug: q.slug, questions };
    } catch (e) {
      // If the interview kickoff fails, release the claim so it can retry.
      await env.DB.prepare(`UPDATE aeo_questions SET status='pending', updated_at=? WHERE slug=?`).bind(now(), q.slug).run();
      return { ok: false, error: `interview kickoff failed: ${String(e?.message || e)}`, question_slug: q.slug };
    }
  }

  try {
    const [brandVoiceDoc, playbookDoc] = await Promise.all([
      readKnowledge(env, 'brand-voice'),
      readKnowledge(env, 'article-playbook'),
    ]);
    if (!brandVoiceDoc?.body)  throw new Error('knowledge doc brand-voice missing');
    if (!playbookDoc?.body)    throw new Error('knowledge doc article-playbook missing');

    // Pull a wider recent window for dedup, but also use the same set to
    // collect the existing tag taxonomy. 200 hits the cap.
    const recentPosts = await listBlogPosts(env, { limit: 200, publishedOnly: true });
    const knownTags   = collectKnownTags(recentPosts);

    // Re-read the question to get expert_context_json (may have been added after
    // the initial nextPendingAeoQuestion() call, e.g. via the interview flow).
    const freshQ       = await readAeoQuestion(env, q.slug);
    const expertContext = formatExpertContext(freshQ?.expert_context_json || null);

    // Editorial taste — learned from the operator's reactions. Folded into the
    // brand voice the writer follows, so the article itself matches taste.
    let taste = null;
    try { const { readTasteProfile } = await import('./aeo-taste.js'); taste = await readTasteProfile(env); } catch {}
    let brandVoiceWithTaste = taste
      ? `${brandVoiceDoc.body}\n\n## Operator's learned editorial taste (honor this)\n${taste}`
      : brandVoiceDoc.body;

    // Optional per-article voice: 'personal' layers the founder's personal voice on
    // top of the house voice. Default 'house' = brand voice only.
    if (freshQ?.voice === 'personal') {
      const personalDoc = await readKnowledge(env, 'personal-voice').catch(() => null);
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

    const draft = await callOpenAIJson(env, { system: SYSTEM_PROMPT, prompt, heavy: true });

    // Sanity-check the draft. Bad shape -> mark failed, don't publish.
    if (!draft.slug || !draft.title || !draft.excerpt || !draft.body_html) {
      throw new Error(`draft missing required fields: ${Object.keys(draft).join(',')}`);
    }
    if (!Array.isArray(draft.tags)) draft.tags = [];

    // Title-collision guard — if a published post already has this exact title,
    // don't create a near-dup with a -2/-3 slug. Mark the question published
    // against the existing post and stop. Belt-and-suspenders on top of the
    // claim lock above.
    const titleNorm = String(draft.title).trim().toLowerCase();
    const existingByTitle = recentPosts.find((p) => String(p.title || '').trim().toLowerCase() === titleNorm);
    if (existingByTitle) {
      await markAeoQuestionPublished(env, q.slug, existingByTitle.slug);
      await logWorkflowRun(env, {
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
    const safeSlug = await ensureUniqueSlug(env, String(draft.slug).trim().toLowerCase());

    // Outbox row — treats a blog publish like any other outbound send so it
    // shows up in the unified Outbox surface (alongside WA + LI sends). If
    // the publish fails the row stays in `failed` state; the wake-up summary
    // surfaces it so Nyo can decide whether to retry.
    const outboxRow = await beginSend(env, {
      channel:    'blog',
      kind:       'publish',
      to_id:      safeSlug,
      to_name:    draft.title,
      body:       draft.excerpt || '',
      payload:    { question_slug: q.slug, slug: safeSlug, target_keyword: q.target_keyword, tags: draft.tags },
      source:     actor === 'aeo-cron' ? 'cron' : 'operator',
      source_ref: q.slug,
    });

    // Save as a DRAFT to blog_posts (published=0). The operator approves it in
    // the Blog module → "Needs review", which publishes + deploys. published_at
    // stays null until approval stamps it.
    try {
      await writeBlogPost(env, {
        slug:         safeSlug,
        title:        draft.title,
        excerpt:      draft.excerpt,
        body:         draft.body_html,
        tags:         draft.tags,
        published_at: null,
        published:    false,
        updated_by:   actor,
      });
      await markSent(env, outboxRow.id, { message_id: safeSlug });
    } catch (writeErr) {
      await markFailed(env, outboxRow.id, writeErr);
      throw writeErr;
    }

    await markAeoQuestionDrafted(env, q.slug, safeSlug);

    // Article figures — best-effort. Generate 2-5 editorial diagrams, embed
    // in body, set featured image to the first figure. LLM picks templates.
    let figures = null;
    try {
      const { generateArticleFigures } = await import('./article-figures.js');
      figures = await generateArticleFigures(env, {
        slug: safeSlug,
        actor,
        trigger_kind: 'aeo',
      });
    } catch (figErr) {
      // swallowed on purpose — figures are nice-to-have, not critical
      console.warn(`[aeo-figures] ${safeSlug}:`, figErr?.message || figErr);
    }

    // A post that only reached local D1 is NOT live on the public site until a
    // deploy actually runs — we must tell the operator the truth instead of
    // always claiming "live".
    // The writer no longer deploys: posts are drafts now. The operator approves
    // in the Blog module → "Needs review", and THAT mirrors to prod + deploys.
    // ponytail: single approval gate, one place to publish from.
    const deploy = { ok: false, reason: 'draft — awaiting your approval in the Blog module' };

    // Featured image. When the figure step set a featured diagram, that IS the
    // featured image — skip the (OpenAI) AI-image generator entirely. Only fall
    // back to AI image generation if no figure was produced. Best-effort: a
    // failure here never rolls back the published article.
    let image = null;
    if (figures?.featured_url) {
      image = { url: figures.featured_url, model: 'article-figure' };
    } else {
      try {
        const img = await generateBlogFeaturedImage(env, {
          slug:    safeSlug,
          title:   draft.title,
          excerpt: draft.excerpt,
          tags:    draft.tags,
          actor,
        });
        image = { url: img.url, model: img.model, size_bytes: img.size_bytes };
      } catch (imgErr) {
        // swallowed on purpose — see comment above
        image = { error: String(imgErr?.message || imgErr).slice(0, 200) };
      }
    }

    await logWorkflowRun(env, {
      workflow_slug: 'aeo-daily-writer',
      status: 'succeeded',
      trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
      trigger_payload: { question_slug: q.slug, target_keyword: q.target_keyword },
      output: { blog_slug: safeSlug, title: draft.title, tags: draft.tags, word_count: draft.body_html.split(/\s+/).length, figures, image, deployed: deploy.ok, deploy_reason: deploy.reason || null },
      started_at: startedAt,
    });

    // Tell Nyo what just happened. Chat polls /api/nyo/pending every 30s
    // and injects this as an assistant turn — the floating Nyo button
    // badges automatically (existing hasUnseen flow).
    const wc = draft.body_html.split(/\s+/).length;
    const tagsLine = Array.isArray(draft.tags) && draft.tags.length ? ` Tagged ${draft.tags.slice(0, 3).join(', ')}.` : '';
    const figLine  = figures?.figures?.length
      ? ` Generated ${figures.figures.length} editorial diagrams.`
      : (figures?.error ? ` Figure generation failed: ${figures.error}.` : '');
    const imgLine  = image?.url
      ? ` Featured image stored at ${image.url}.`
      : (image?.error ? ` Image generation failed: ${image.error}.` : '');
    const trigger  = actor === 'aeo-cron' ? 'the daily cron' : `you (${actor})`;
    const liveLine = `Triggered by ${trigger}. It's saved as a **draft** — open the **Blog** module → **Needs review** to read it and approve. Approving publishes it to your public site.`;
    await queueNyoMessage(env, {
      kind:     'aeo_drafted',
      ref_kind: 'blog_posts',
      ref_id:   safeSlug,
      content:
        `📝 **Drafted a new article for your review.**\n\n` +
        `**"${draft.title}"**, answering the AEO question \`${q.slug}\`. ${wc} words.${tagsLine}${figLine}${imgLine}\n\n` +
        `${liveLine}`,
      payload: { blog_slug: safeSlug, question_slug: q.slug, title: draft.title, word_count: wc, figures, image, deployed: false, status: 'draft' },
    });

    return { ok: true, question_slug: q.slug, blog_slug: safeSlug, title: draft.title, figures, image, deployed: deploy.ok, deploy_reason: deploy.reason || null };
  } catch (e) {
    const msg = e?.message || String(e);
    // Main model out of credit → PAUSE, don't fail. Release the claim back to
    // pending so a later cron (once credit is topped up) picks the question up
    // again, and skip the alarming "writer failed" notice — the circuit-breaker
    // already queued the single "out of credit" message when it opened.
    if (e?.llmDown) {
      await env.DB.prepare(`UPDATE aeo_questions SET status='pending', updated_at=? WHERE slug=?`).bind(now(), q.slug).run();
      await logWorkflowRun(env, {
        workflow_slug: 'aeo-daily-writer',
        status: 'skipped',
        trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
        trigger_payload: { question_slug: q.slug },
        output: { paused: true, reason: 'primary LLM out of credit — article writing paused until topped up' },
        started_at: startedAt,
      });
      return { ok: false, paused: true, reason: 'llm_out_of_credit', question_slug: q.slug };
    }
    await markAeoQuestionFailed(env, q.slug, msg);
    await logWorkflowRun(env, {
      workflow_slug: 'aeo-daily-writer',
      status: 'failed',
      trigger_kind: actor === 'aeo-cron' ? 'cron' : 'manual',
      trigger_payload: { question_slug: q.slug },
      error: msg,
      started_at: startedAt,
    });
    // Notify Nyo about the failure too.
    await queueNyoMessage(env, {
      kind:     'aeo_failed',
      ref_kind: 'aeo_questions',
      ref_id:   q.slug,
      content:
        `⚠️ **AEO writer failed.**\n\n` +
        `Tried to draft \`${q.slug}\` and hit: ${msg}\n\n` +
        `The question stays in the queue so you can retry. Ask me to look at it.`,
      payload: { question_slug: q.slug, error: msg },
    });
    return { ok: false, error: msg, question_slug: q.slug };
  }
}
