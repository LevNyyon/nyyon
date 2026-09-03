// Editorial plugin — blog_posts + aeo_questions + aeo_feedback store helpers.
// Ported from workers/api/src/lib/db.js (blog posts family ~417-534, AEO
// question helpers ~792-900 + setAeoVoice ~1005, aeo_feedback ~902-915) under
// the plugin capability contract: every function takes `api` first, tables are
// renamed into the plugin namespace, logEvent becomes api.log. This file
// imports NOTHING.
//
// Tables: plugin_editorial_blog_posts, plugin_editorial_aeo_questions,
//         plugin_editorial_aeo_feedback
// Gateways: none

const now = () => Date.now();
const uid = () => crypto.randomUUID();

// ─── blog posts ──────────────────────────────────────────────
export async function listBlogPosts(api, { limit = 200, publishedOnly = true } = {}) {
  const sql = publishedOnly
    ? 'SELECT slug, title, excerpt, tags, published_at, published, updated_at, updated_by FROM plugin_editorial_blog_posts WHERE published = 1 ORDER BY published_at DESC LIMIT ?'
    : 'SELECT slug, title, excerpt, tags, published_at, published, updated_at, updated_by FROM plugin_editorial_blog_posts ORDER BY published_at DESC LIMIT ?';
  const r = await api.db.prepare(sql).bind(limit).all();
  return r.results || [];
}

export async function readBlogPost(api, slug) {
  return api.db.prepare('SELECT * FROM plugin_editorial_blog_posts WHERE slug = ?').bind(slug).first();
}

// Universal typography guard: the operator has a hard, standing rule of NO
// en-dashes or em-dashes anywhere in any post. Strip them on EVERY write so it
// cannot slip through regardless of which path produced the text.
export function stripDashes(s) {
  if (s == null) return s;
  return String(s)
    .replace(/\s*—\s*/g, ', ')  // em-dash -> comma + space
    .replace(/\s*–\s*/g, '-');  // en-dash -> hyphen
}

export async function writeBlogPost(api, { slug, title, excerpt = null, body = null, tags = null, published_at = null, published = true, updated_by = 'operator' }) {
  const t = now();
  title = stripDashes(title); excerpt = stripDashes(excerpt); body = stripDashes(body);
  const existing = await readBlogPost(api, slug);
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

  return readBlogPost(api, slug);
}

// Safe partial edit: changes ONLY the fields passed; everything else is
// preserved. Reuses writeBlogPost so the event log still
// fires. Throws if the post doesn't exist (use writeBlogPost to create).
export async function patchBlogPost(api, slug, patch = {}) {
  const existing = await readBlogPost(api, slug);
  if (!existing) throw new Error(`blog post not found: ${slug}`);
  return writeBlogPost(api, {
    slug,
    title:        patch.title        !== undefined ? patch.title        : existing.title,
    excerpt:      patch.excerpt      !== undefined ? patch.excerpt      : existing.excerpt,
    body:         patch.body         !== undefined ? patch.body         : existing.body,
    tags:         patch.tags         !== undefined ? patch.tags         : existing.tags, // string ok
    published_at: patch.published_at !== undefined ? patch.published_at : existing.published_at,
    published:    patch.published    !== undefined ? patch.published    : !!existing.published,
    updated_by:   patch.updated_by || 'nyo',
  });
}

export async function deleteBlogPost(api, slug) {
  await api.db.prepare('DELETE FROM plugin_editorial_blog_posts WHERE slug = ?').bind(slug).run();
  await api.log('blog_post_deleted', { slug });
}

// ─── AEO questions (writer backlog) ───────────────────────────
export async function listAeoQuestions(api, { status = null, limit = 200 } = {}) {
  const sql = status
    ? 'SELECT * FROM plugin_editorial_aeo_questions WHERE status = ? ORDER BY priority ASC, updated_at DESC LIMIT ?'
    : 'SELECT * FROM plugin_editorial_aeo_questions ORDER BY priority ASC, updated_at DESC LIMIT ?';
  const stmt = status ? api.db.prepare(sql).bind(status, limit) : api.db.prepare(sql).bind(limit);
  const r = await stmt.all();
  return r.results || [];
}

export async function readAeoQuestion(api, slug) {
  return api.db.prepare('SELECT * FROM plugin_editorial_aeo_questions WHERE slug = ?').bind(slug).first();
}

export async function writeAeoQuestion(api, { slug, question, target_keyword = null, priority = 5, status = 'pending', scheduled_for = null, notes = null }) {
  if (!slug || !question) throw new Error('slug + question required');
  const t = now();
  const existing = await readAeoQuestion(api, slug);
  if (existing) {
    await api.db.prepare(
      `UPDATE plugin_editorial_aeo_questions SET question=?, target_keyword=?, priority=?, status=?, scheduled_for=?, notes=?, updated_at=? WHERE slug=?`,
    ).bind(question, target_keyword, priority, status, scheduled_for, notes, t, slug).run();
  } else {
    await api.db.prepare(
      `INSERT INTO plugin_editorial_aeo_questions (slug, question, target_keyword, priority, status, scheduled_for, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(slug, question, target_keyword, priority, status, scheduled_for, notes, t, t).run();
  }
  await api.log('aeo_question_upserted', { slug, status });
  return readAeoQuestion(api, slug);
}

// Create a fresh AEO question from just its text. Slugifies the question and
// guarantees a unique slug (so a new topic never overwrites an existing one).
export async function addAeoQuestion(api, { question, target_keyword = null, notes = null, priority = 3 } = {}) {
  const q = String(question || '').trim();
  if (!q) throw new Error('question required');
  const base = (q.toLowerCase().replace(/['"“”]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)) || 'question';
  let slug = base;
  for (let n = 2; await readAeoQuestion(api, slug); n++) { slug = `${base}-${n}`; if (n > 99) { slug = `${base}-${now()}`; break; } }
  return writeAeoQuestion(api, { slug, question: q, target_keyword, notes, priority, status: 'pending' });
}

// Hard-delete an AEO question by slug. Returns true if a row existed.
// blog_posts rows are left intact — even if the source question gets pruned,
// the published article stays live.
export async function deleteAeoQuestion(api, slug) {
  const existing = await readAeoQuestion(api, slug);
  if (!existing) return false;
  await api.db.prepare('DELETE FROM plugin_editorial_aeo_questions WHERE slug = ?').bind(slug).run();
  await api.log('aeo_question_deleted', { slug, status: existing.status, drafted_blog_slug: existing.drafted_blog_slug });
  return true;
}

// Picks the next eligible question for the cron writer.
// Eligible = status=pending AND (scheduled_for is null OR scheduled_for <= now)
// AND no interview in flight (fresh, or answers already in).
export async function nextPendingAeoQuestion(api) {
  const t = now();
  return api.db.prepare(
    `SELECT * FROM plugin_editorial_aeo_questions
     WHERE status = 'pending'
       AND (scheduled_for IS NULL OR scheduled_for <= ?)
       AND (interview_status IS NULL OR interview_status = 'ready')
     ORDER BY priority ASC, created_at ASC LIMIT 1`,
  ).bind(t).first();
}

// Like nextPendingAeoQuestion, but ONLY a question that is READY to publish
// unattended: interview answers captured AND its scheduled date has arrived.
export async function nextScheduledReadyAeoQuestion(api) {
  const t = now();
  return api.db.prepare(
    `SELECT * FROM plugin_editorial_aeo_questions
     WHERE status = 'pending'
       AND interview_status = 'ready'
       AND (scheduled_for IS NULL OR scheduled_for <= ?)
     ORDER BY priority ASC, created_at ASC LIMIT 1`,
  ).bind(t).first();
}

export async function markAeoQuestionPublished(api, slug, blog_slug) {
  const t = now();
  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET status='published', drafted_blog_slug=?, last_error=NULL, updated_at=? WHERE slug=?`,
  ).bind(blog_slug, t, slug).run();
  await api.log('aeo_question_published', { question_slug: slug, blog_slug });
}

// The writer saves a DRAFT the operator approves in the Blog module — the
// question is done from the writer's side, but the post is not live yet.
export async function markAeoQuestionDrafted(api, slug, blog_slug) {
  const t = now();
  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET status='drafted', drafted_blog_slug=?, last_error=NULL, updated_at=? WHERE slug=?`,
  ).bind(blog_slug, t, slug).run();
  await api.log('aeo_question_drafted', { question_slug: slug, blog_slug });
}

export async function markAeoQuestionFailed(api, slug, error_msg) {
  const t = now();
  await api.db.prepare(
    `UPDATE plugin_editorial_aeo_questions SET status='failed', last_error=?, attempts=attempts+1, updated_at=? WHERE slug=?`,
  ).bind(String(error_msg).slice(0, 1000), t, slug).run();
  await api.log('aeo_question_failed', { slug, error: String(error_msg).slice(0, 200) });
}

// Voice isn't part of writeAeoQuestion's column set; set it directly.
export async function setAeoVoice(api, slug, voice) {
  await api.db.prepare(`UPDATE plugin_editorial_aeo_questions SET voice=? WHERE slug=?`).bind(voice, slug).run();
}

// ─── AEO feedback (operator reactions to idea quality) ─────────
export async function recordAeoFeedback(api, { question_slug = null, idea_title = null, reaction, note = null }) {
  if (!reaction) throw new Error('reaction required');
  const id = uid();
  await api.db.prepare(
    `INSERT INTO plugin_editorial_aeo_feedback (id, question_slug, idea_title, reaction, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, question_slug, idea_title, reaction, note, now()).run();
  await api.log('aeo_feedback', { question_slug, idea_title, reaction });
  return { id, question_slug, idea_title, reaction, note };
}

export async function recentAeoFeedback(api, { limit = 60 } = {}) {
  const r = await api.db.prepare(`SELECT * FROM plugin_editorial_aeo_feedback ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
  return r.results || [];
}
