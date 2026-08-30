// D1 helpers for Nyyon Command Center.
// Knowledge, events, flags, roadmap, modules, tools.

import { uid, now, safeJSON } from './util.js';

// ─── events / activity log ─────────────────────────────────────
// The single writer to the activity bus. `kind` is a NOT NULL column and the
// value every reader/guard keys off, so a missing or malformed kind is a bug
// worth surfacing loudly rather than a cryptic D1 error deep in a call stack.
// (This is the exact class that let post_to_social pass {type:'x'} instead of
// {kind:'x'} and record a successful post as a failure — see event-kinds.js.)
export async function logEvent(env, { kind, actor = 'system', payload = null }) {
  if (typeof kind !== 'string' || !kind.trim()) {
    throw new Error(`logEvent: "kind" must be a non-empty string (got ${JSON.stringify(kind)}) — pass { kind, actor, payload }`);
  }
  await env.DB.prepare(
    `INSERT INTO events (id, kind, actor, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(uid(), kind, actor, payload ? JSON.stringify(payload) : null, now()).run();
}
export async function recentEvents(env, limit = 100) {
  const r = await env.DB.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return (r.results || []).map((e) => ({ ...e, payload: safeJSON(e.payload) }));
}

// ─── knowledge docs ────────────────────────────────────────────
// Knowledge is a tree, not a flat list. Every doc has a `parent_slug`
// pointing at its parent (NULL for the root `nyyon-root`). The list
// endpoint returns rows in tree order — root first, then breadth-first
// per branch — so both the sidebar and Nyo see a stable shape.
export async function listKnowledge(env, { scope = null, module = null } = {}) {
  let sql = 'SELECT slug, title, scope, module, parent_slug, updated_at FROM knowledge_docs';
  const where = []; const args = [];
  if (scope)  { where.push('scope = ?');  args.push(scope); }
  if (module) { where.push('module = ?'); args.push(module); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  // Order by parent_slug-first so the natural list reads top-down; the UI
  // sorts within siblings by title.
  sql += ' ORDER BY (parent_slug IS NULL) DESC, parent_slug, scope, module, slug';
  const r = await env.DB.prepare(sql).bind(...args).all();
  return r.results || [];
}
export async function readKnowledge(env, slug) {
  return env.DB.prepare('SELECT * FROM knowledge_docs WHERE slug = ?').bind(slug).first();
}
// Return the breadcrumb path for a slug — ordered root → … → self. Useful
// for Nyo when answering "what context do I need to know X" and for the UI
// breadcrumb strip. Bounded to 16 hops to defend against cycles.
export async function readKnowledgePath(env, slug) {
  const path = [];
  let cursor = slug;
  for (let i = 0; cursor && i < 16; i++) {
    const r = await env.DB.prepare(
      'SELECT slug, title, parent_slug FROM knowledge_docs WHERE slug = ?'
    ).bind(cursor).first();
    if (!r) break;
    path.unshift({ slug: r.slug, title: r.title });
    cursor = r.parent_slug;
  }
  return path;
}
export async function writeKnowledge(env, { slug, title, body, scope = 'global', module = null, parent_slug = undefined }) {
  const t = now();
  const existing = await readKnowledge(env, slug);
  if (existing) {
    // `parent_slug` is intentionally optional on update — pass `null` to
    // explicitly orphan a doc, pass `undefined` (or omit) to keep its
    // current parent. Lets Nyo edit a doc body without reshaping the tree.
    const nextParent = parent_slug === undefined ? existing.parent_slug : parent_slug;
    await env.DB.prepare(
      `UPDATE knowledge_docs SET title = ?, body = ?, scope = ?, module = ?, parent_slug = ?, updated_at = ? WHERE slug = ?`,
    ).bind(title, body, scope, module, nextParent, t, slug).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO knowledge_docs (slug, title, body, scope, module, parent_slug, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(slug, title, body, scope, module, parent_slug || null, t).run();
  }
  await logEvent(env, { kind: 'knowledge_updated', actor: 'nyo', payload: { slug, title, parent_slug } });
  return readKnowledge(env, slug);
}
export async function deleteKnowledge(env, slug) {
  // Children become roots — safer than cascading. The operator can re-parent
  // them after; deleting an arbitrary subtree silently is a footgun.
  await env.DB.prepare('UPDATE knowledge_docs SET parent_slug = NULL WHERE parent_slug = ?').bind(slug).run();
  await env.DB.prepare('DELETE FROM knowledge_docs WHERE slug = ?').bind(slug).run();
  await logEvent(env, { kind: 'knowledge_deleted', payload: { slug } });
}

// ─── contacts — operator-curated layer on top of identities ──
const CONTACT_STATUSES = ['prospect', 'lead', 'client', 'past_client', 'partner', 'do_not_contact'];
const CONTACT_SOURCES  = ['referral', 'inbound_form', 'inbound_wa', 'inbound_email', 'paid_ad', 'event', 'cold_outreach', 'social', 'other'];

function normalizeTags(t) {
  if (t === undefined || t === null) return null;
  if (typeof t === 'string') return t; // assume already JSON
  if (Array.isArray(t)) return JSON.stringify(t.map(String).map((s) => s.trim()).filter(Boolean));
  return null;
}

// Filters: status, source, owner (multi via comma), tag (single — matches JSON), search (name/email/phone/company), starred (1 only)
export async function listContacts(env, { status = null, source = null, owner = null, tag = null, search = null, starred = false, client_id = null, unassigned = false, limit = 200 } = {}) {
  let sql = 'SELECT * FROM contacts';
  const where = []; const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (source) { where.push('source = ?'); args.push(source); }
  if (owner)  {
    const owners = String(owner).split(',').map((s) => s.trim()).filter(Boolean);
    if (owners.length === 1) { where.push('owner = ?'); args.push(owners[0]); }
    else if (owners.length > 1) {
      where.push(`owner IN (${owners.map(() => '?').join(',')})`);
      args.push(...owners);
    }
  }
  if (tag) {
    // Naive LIKE — fine for sub-1000-row contact lists; revisit if it ever scales.
    where.push('tags LIKE ?');
    args.push(`%"${tag}"%`);
  }
  if (search) {
    where.push('(LOWER(full_name) LIKE ? OR LOWER(email) LIKE ? OR phone LIKE ? OR LOWER(company) LIKE ?)');
    const s = `%${String(search).toLowerCase()}%`;
    args.push(s, s, `%${search}%`, s);
  }
  if (starred) where.push('starred = 1');
  if (client_id) { where.push('client_id = ?'); args.push(client_id); }
  if (unassigned) where.push('client_id IS NULL');
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY starred DESC, updated_at DESC LIMIT ?';
  args.push(limit);
  const r = await env.DB.prepare(sql).bind(...args).all();
  return (r.results || []).map((c) => ({ ...c, tags: safeJSON(c.tags) }));
}

export async function readContact(env, id) {
  const c = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
  return c ? { ...c, tags: safeJSON(c.tags) } : null;
}

export async function writeContact(env, body) {
  const t = now();
  const id = body.id || uid();
  const status = body.status || 'prospect';
  if (!CONTACT_STATUSES.includes(status)) throw new Error(`bad status ${status}. Allowed: ${CONTACT_STATUSES.join(', ')}`);
  if (body.source && !CONTACT_SOURCES.includes(body.source)) throw new Error(`bad source ${body.source}. Allowed: ${CONTACT_SOURCES.join(', ')}`);

  const existing = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
  const fields = {
    identity_id:  body.identity_id ?? existing?.identity_id ?? null,
    full_name:    body.full_name ?? existing?.full_name ?? null,
    email:        body.email ?? existing?.email ?? null,
    phone:        body.phone ?? existing?.phone ?? null,
    company:      body.company ?? existing?.company ?? null,
    title:        body.title ?? existing?.title ?? null,
    linkedin_url: body.linkedin_url ?? existing?.linkedin_url ?? null,
    client_id:    body.client_id ?? existing?.client_id ?? null,
    status,
    source:      body.source ?? existing?.source ?? null,
    owner:       body.owner ?? existing?.owner ?? null,
    tags:        normalizeTags(body.tags),
    notes:       body.notes ?? existing?.notes ?? null,
    starred:     body.starred !== undefined ? (body.starred ? 1 : 0) : (existing?.starred ?? 0),
  };

  // Keep the display `company` column in sync when linking to a client and no
  // explicit company was supplied — the flat contact list renders `company`.
  if (fields.client_id && !fields.company) {
    const cl = await env.DB.prepare('SELECT name FROM clients WHERE id = ?').bind(fields.client_id).first();
    if (cl?.name) fields.company = cl.name;
  }

  if (existing) {
    await env.DB.prepare(
      `UPDATE contacts SET
         identity_id=?, full_name=?, email=?, phone=?, company=?, title=?, linkedin_url=?, client_id=?,
         status=?, source=?, owner=?, tags=?, notes=?, starred=?,
         updated_at=?, updated_by=?
       WHERE id=?`,
    ).bind(
      fields.identity_id, fields.full_name, fields.email, fields.phone, fields.company, fields.title, fields.linkedin_url, fields.client_id,
      fields.status, fields.source, fields.owner, fields.tags, fields.notes, fields.starred,
      t, body.updated_by || 'operator', id,
    ).run();
    await logEvent(env, { kind: 'contact_updated', actor: body.updated_by || 'operator', payload: { id, full_name: fields.full_name, status: fields.status } });
  } else {
    await env.DB.prepare(
      `INSERT INTO contacts (id, identity_id, full_name, email, phone, company, title, linkedin_url, client_id,
                             status, source, owner, tags, notes, starred,
                             created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?)`,
    ).bind(
      id, fields.identity_id, fields.full_name, fields.email, fields.phone, fields.company, fields.title, fields.linkedin_url, fields.client_id,
      fields.status, fields.source, fields.owner, fields.tags, fields.notes, fields.starred,
      t, t, body.created_by || 'operator', body.updated_by || 'operator',
    ).run();
    await logEvent(env, { kind: 'contact_added', actor: body.created_by || 'operator', payload: { id, full_name: fields.full_name, status: fields.status, source: fields.source } });
  }
  return readContact(env, id);
}

export async function deleteContact(env, id) {
  await env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(id).run();
  await logEvent(env, { kind: 'contact_deleted', payload: { id } });
}

// Returns the data the filter UI needs: enums + DISTINCT owners + DISTINCT tags
// across all contacts so the operator can pick from a live set.
export async function listContactTaxonomy(env) {
  const ownersR = await env.DB.prepare('SELECT DISTINCT owner FROM contacts WHERE owner IS NOT NULL AND owner != "" ORDER BY owner').all();
  const tagsR   = await env.DB.prepare('SELECT tags FROM contacts WHERE tags IS NOT NULL').all();
  const tagSet = new Set();
  for (const row of (tagsR.results || [])) {
    const parsed = safeJSON(row.tags);
    if (Array.isArray(parsed)) for (const t of parsed) if (typeof t === 'string') tagSet.add(t);
  }
  return {
    statuses: CONTACT_STATUSES,
    sources:  CONTACT_SOURCES,
    owners:   (ownersR.results || []).map((r) => r.owner),
    tags:     [...tagSet].sort(),
  };
}

export const CONTACT_VOCAB = { CONTACT_STATUSES, CONTACT_SOURCES };

// ─── clients (companies / accounts — the CRM layer above contacts) ──
// A client is a company Nyyon does (or did) work for. Contacts link to it via
// contacts.client_id. Status is account-level (are we engaged?), distinct from
// a contact's person-level status.
const CLIENT_STATUSES = ['active', 'past', 'prospect', 'partner'];

export async function listClients(env, { status = null, tag = null, search = null, starred = false, limit = 500 } = {}) {
  // contact_count is computed per row so the list view can show "Acme Corp · 3 contacts".
  let sql = 'SELECT c.*, (SELECT COUNT(*) FROM contacts ct WHERE ct.client_id = c.id) AS contact_count FROM clients c';
  const where = []; const args = [];
  if (status) { where.push('c.status = ?'); args.push(status); }
  if (tag)    { where.push('c.tags LIKE ?'); args.push(`%"${tag}"%`); }
  if (search) {
    where.push('(LOWER(c.name) LIKE ? OR LOWER(c.industry) LIKE ? OR LOWER(c.engagement) LIKE ?)');
    const s = `%${String(search).toLowerCase()}%`;
    args.push(s, s, s);
  }
  if (starred) where.push('c.starred = 1');
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY c.starred DESC, c.updated_at DESC LIMIT ?';
  args.push(limit);
  const r = await env.DB.prepare(sql).bind(...args).all();
  return (r.results || []).map((c) => ({ ...c, tags: safeJSON(c.tags) }));
}

export async function readClient(env, id) {
  const c = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  return c ? { ...c, tags: safeJSON(c.tags) } : null;
}

// Account detail: the client plus every contact linked to it.
export async function readClientWithContacts(env, id) {
  const client = await readClient(env, id);
  if (!client) return null;
  const contacts = await listContacts(env, { client_id: id, limit: 500 });
  return { ...client, contacts };
}

export async function writeClient(env, body) {
  const t = now();
  const id = body.id || uid();
  const status = body.status || 'active';
  if (!CLIENT_STATUSES.includes(status)) throw new Error(`bad status ${status}. Allowed: ${CLIENT_STATUSES.join(', ')}`);

  const existing = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  const fields = {
    name:       body.name ?? existing?.name ?? null,
    status,
    industry:   body.industry ?? existing?.industry ?? null,
    website:    body.website ?? existing?.website ?? null,
    engagement: body.engagement ?? existing?.engagement ?? null,
    owner:      body.owner ?? existing?.owner ?? null,
    tags:       normalizeTags(body.tags),
    notes:      body.notes ?? existing?.notes ?? null,
    starred:    body.starred !== undefined ? (body.starred ? 1 : 0) : (existing?.starred ?? 0),
  };
  if (!fields.name) throw new Error('client name required');

  if (existing) {
    await env.DB.prepare(
      `UPDATE clients SET name=?, status=?, industry=?, website=?, engagement=?, owner=?, tags=?, notes=?, starred=?, updated_at=?, updated_by=? WHERE id=?`,
    ).bind(
      fields.name, fields.status, fields.industry, fields.website, fields.engagement, fields.owner, fields.tags, fields.notes, fields.starred,
      t, body.updated_by || 'operator', id,
    ).run();
    await logEvent(env, { kind: 'client_updated', actor: body.updated_by || 'operator', payload: { id, name: fields.name, status: fields.status } });
  } else {
    await env.DB.prepare(
      `INSERT INTO clients (id, name, status, industry, website, engagement, owner, tags, notes, starred,
                            created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?)`,
    ).bind(
      id, fields.name, fields.status, fields.industry, fields.website, fields.engagement, fields.owner, fields.tags, fields.notes, fields.starred,
      t, t, body.created_by || 'operator', body.updated_by || 'operator',
    ).run();
    await logEvent(env, { kind: 'client_added', actor: body.created_by || 'operator', payload: { id, name: fields.name, status: fields.status } });
  }
  return readClient(env, id);
}

export async function deleteClient(env, id) {
  // Unlink contacts rather than delete them — a person outlives the account.
  await env.DB.prepare('UPDATE contacts SET client_id = NULL WHERE client_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(id).run();
  await logEvent(env, { kind: 'client_deleted', payload: { id } });
}

export async function listClientTaxonomy(env) {
  const ownersR = await env.DB.prepare('SELECT DISTINCT owner FROM clients WHERE owner IS NOT NULL AND owner != "" ORDER BY owner').all();
  const tagsR   = await env.DB.prepare('SELECT tags FROM clients WHERE tags IS NOT NULL').all();
  const tagSet = new Set();
  for (const row of (tagsR.results || [])) {
    const parsed = safeJSON(row.tags);
    if (Array.isArray(parsed)) for (const t of parsed) if (typeof t === 'string') tagSet.add(t);
  }
  return { statuses: CLIENT_STATUSES, owners: (ownersR.results || []).map((r) => r.owner), tags: [...tagSet].sort() };
}

export const CLIENT_VOCAB = { CLIENT_STATUSES };

// ─── home_sections — per-section visibility + ordering ──────
export async function listSections(env, page = 'home') {
  const r = await env.DB.prepare(
    'SELECT * FROM home_sections WHERE page = ? ORDER BY position',
  ).bind(page).all();
  return r.results || [];
}
export async function upsertSection(env, id, data) {
  const t = now();
  await env.DB.prepare(
    'INSERT INTO home_sections (id, page, label, position, visible, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label=excluded.label, position=excluded.position, visible=excluded.visible, updated_at=excluded.updated_at, updated_by=excluded.updated_by',
  ).bind(id, data.page || 'home', data.label, data.position, data.visible ?? 1, t, 'operator').run();
  await logEvent(env, { kind: 'section_updated', actor: 'operator', payload: { id, page: data.page || 'home', label: data.label } });
  return env.DB.prepare('SELECT * FROM home_sections WHERE id = ?').bind(id).first();
}
export async function patchSection(env, id, patch) {
  const t = now();
  const existing = await env.DB.prepare('SELECT * FROM home_sections WHERE id = ?').bind(id).first();
  if (!existing) throw new Error(`unknown section ${id}`);
  const next = {
    label:    patch.label    ?? existing.label,
    position: patch.position ?? existing.position,
    visible:  patch.visible !== undefined ? (patch.visible ? 1 : 0) : existing.visible,
  };
  await env.DB.prepare(
    'UPDATE home_sections SET label=?, position=?, visible=?, updated_at=?, updated_by=? WHERE id=?',
  ).bind(next.label, next.position, next.visible, t, patch.updated_by || 'operator', id).run();
  await logEvent(env, { kind: 'section_updated', actor: 'operator', payload: { id, patch: next } });
  return env.DB.prepare('SELECT * FROM home_sections WHERE id = ?').bind(id).first();
}
// Bulk reorder — accepts a full ordered list of section ids. Re-numbers
// positions in 10-step increments so future inserts are easy.
export async function reorderSections(env, page, orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) throw new Error('orderedIds required');
  const t = now();
  for (let i = 0; i < orderedIds.length; i++) {
    await env.DB.prepare(
      'UPDATE home_sections SET position = ?, updated_at = ?, updated_by = ? WHERE id = ? AND page = ?',
    ).bind((i + 1) * 10, t, 'operator', orderedIds[i], page).run();
  }
  await logEvent(env, { kind: 'sections_reordered', actor: 'operator', payload: { page, order: orderedIds } });
  return listSections(env, page);
}
export async function deleteSection(env, id) {
  const existing = await env.DB.prepare('SELECT * FROM home_sections WHERE id = ?').bind(id).first();
  if (!existing) return { ok: false, error: `unknown section ${id}` };
  await env.DB.prepare('DELETE FROM home_sections WHERE id = ?').bind(id).run();
  await logEvent(env, { kind: 'section_deleted', actor: 'operator', payload: { id } });
  return { ok: true, id };
}

// ─── content blocks (editable website copy) ──────────────────
// full=true returns body too — used by the public site to hydrate in one call.
export async function listContent(env, { page = null, section = null, full = false } = {}) {
  const cols = full
    ? 'slug, title, body, kind, page, section, updated_at, updated_by, published_at'
    : 'slug, title, kind, page, section, updated_at, updated_by, published_at';
  let sql = `SELECT ${cols} FROM content_blocks`;
  const where = []; const args = [];
  if (page)    { where.push('page = ?');    args.push(page); }
  if (section) { where.push('section = ?'); args.push(section); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY page, section, slug';
  const r = await env.DB.prepare(sql).bind(...args).all();
  return r.results || [];
}
export async function readContent(env, slug) {
  return env.DB.prepare('SELECT * FROM content_blocks WHERE slug = ?').bind(slug).first();
}
export async function writeContent(env, { slug, title, body, kind = 'text', page = null, section = null, updated_by = 'operator' }) {
  const t = now();
  const existing = await readContent(env, slug);
  if (existing) {
    await env.DB.prepare(
      `UPDATE content_blocks SET title=?, body=?, kind=?, page=?, section=?, updated_at=?, updated_by=? WHERE slug=?`,
    ).bind(title, body, kind, page, section, t, updated_by, slug).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO content_blocks (slug, title, body, kind, page, section, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(slug, title, body, kind, page, section, t, updated_by).run();
  }
  await logEvent(env, { kind: 'content_updated', actor: updated_by, payload: { slug, title, page } });
  return readContent(env, slug);
}
export async function deleteContent(env, slug) {
  await env.DB.prepare('DELETE FROM content_blocks WHERE slug = ?').bind(slug).run();
  await logEvent(env, { kind: 'content_deleted', payload: { slug } });
}

// ─── blog posts (plugin-owned table; host render impls read it) ──────────────
// The Blog/AEO module ships as the editorial plugin, which owns
// plugin_editorial_blog_posts. The host keeps ONE read helper because the
// render gateway impls (lib/article-figures.js renderCover, and the
// candidate-image renderer) fall back to the post row when a caller passes
// only a slug. Host code may read/write plugin_editorial_* tables; all the
// write helpers moved into the pack (plugins/editorial/lib/blog-db.mjs).
export async function readBlogPost(env, slug) {
  return env.DB.prepare('SELECT * FROM plugin_editorial_blog_posts WHERE slug = ?').bind(slug).first();
}
// Universal typography guard: the operator has a hard, standing rule of NO
// en-dashes or em-dashes anywhere in any post. Strip them on EVERY write so it
// cannot slip through regardless of which path (LLM draft, expand, cron, manual,
// figure re-embed) produced the text. Plain hyphens are fine and left alone.
export function stripDashes(s) {
  if (s == null) return s;
  return String(s)
    .replace(/\s*—\s*/g, ', ')  // em-dash -> comma + space
    .replace(/\s*–\s*/g, '-');  // en-dash -> hyphen
}

// ─── workflows (definition + run history) ───────────────────────────
function decodeWorkflow(w) {
  if (!w) return null;
  return { ...w, trigger: safeJSON(w.trigger), steps: safeJSON(w.steps) };
}
function decodeRun(r) {
  if (!r) return null;
  return {
    ...r,
    trigger_payload: safeJSON(r.trigger_payload),
    output:          safeJSON(r.output),
  };
}

export async function listWorkflows(env, { source = null, status = null } = {}) {
  const where = []; const args = [];
  if (source) { where.push('source = ?'); args.push(source); }
  if (status) { where.push('status = ?'); args.push(status); }
  const sql = `SELECT * FROM workflows${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY source, slug`;
  const r = await env.DB.prepare(sql).bind(...args).all();
  return (r.results || []).map(decodeWorkflow);
}

export async function readWorkflow(env, slug) {
  const w = await env.DB.prepare('SELECT * FROM workflows WHERE slug = ?').bind(slug).first();
  return decodeWorkflow(w);
}

export async function writeWorkflow(env, { slug, name, description = null, trigger, steps, source = 'nyo', status = 'active', created_by = null, updated_by = null }) {
  if (!slug || !name || !trigger || !steps) throw new Error('slug, name, trigger, steps required');
  const t = now();
  const triggerJson = typeof trigger === 'string' ? trigger : JSON.stringify(trigger);
  const stepsJson   = typeof steps   === 'string' ? steps   : JSON.stringify(steps);
  const existing = await readWorkflow(env, slug);
  if (existing) {
    await env.DB.prepare(
      `UPDATE workflows SET name=?, description=?, trigger=?, steps=?, source=?, status=?, updated_at=?, updated_by=? WHERE slug=?`,
    ).bind(name, description, triggerJson, stepsJson, source, status, t, updated_by || created_by, slug).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO workflows (slug, name, description, trigger, steps, source, status, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(slug, name, description, triggerJson, stepsJson, source, status, t, t, created_by || updated_by, updated_by || created_by).run();
  }
  await logEvent(env, { kind: existing ? 'workflow_updated' : 'workflow_created', actor: updated_by || created_by, payload: { slug, source } });
  return readWorkflow(env, slug);
}

export async function deleteWorkflow(env, slug) {
  await env.DB.prepare('DELETE FROM workflows WHERE slug = ?').bind(slug).run();
  await logEvent(env, { kind: 'workflow_deleted', payload: { slug } });
}

// Run-history helpers. logWorkflowRun() is called by every system workflow
// hook so the Workflows page surfaces real execution history.
export async function listWorkflowRuns(env, { workflow_slug = null, status = null, limit = 50 } = {}) {
  const where = []; const args = [];
  if (workflow_slug) { where.push('workflow_slug = ?'); args.push(workflow_slug); }
  if (status)        { where.push('status = ?');        args.push(status); }
  const sql = `SELECT * FROM workflow_runs${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT ?`;
  const r = await env.DB.prepare(sql).bind(...args, limit).all();
  return (r.results || []).map(decodeRun);
}

export async function logWorkflowRun(env, { workflow_slug, status, trigger_kind = null, trigger_payload = null, output = null, error = null, started_at = null, finished_at = null }) {
  const id = 'wr_' + uid();
  const t  = now();
  await env.DB.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_slug, status, trigger_kind, trigger_payload, output, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, workflow_slug, status, trigger_kind,
    trigger_payload ? (typeof trigger_payload === 'string' ? trigger_payload : JSON.stringify(trigger_payload)) : null,
    output          ? (typeof output          === 'string' ? output          : JSON.stringify(output))          : null,
    error ? String(error).slice(0, 1000) : null,
    started_at  || t,
    finished_at || t,
  ).run();
  return { id };
}

// ─── calendar events (central event store, any module can write) ────
export const CALENDAR_KINDS    = ['meeting', 'social_post', 'blog_publish', 'campaign', 'deadline', 'other'];
export const CALENDAR_STATUSES = ['pending', 'confirmed', 'done', 'cancelled'];

function normaliseAttendees(a) {
  if (!a) return null;
  if (Array.isArray(a)) return JSON.stringify(a);
  if (typeof a === 'string') return a; // assume already JSON
  return JSON.stringify([a]);
}

// Range-scoped list. Pass `from`/`to` as ms epochs. Either bound can be null.
// Filters: kind (string or array), source (string).
export async function listCalendarEvents(env, { from = null, to = null, kind = null, source = null, limit = 1000 } = {}) {
  const where = []; const args = [];
  if (from !== null) { where.push('starts_at >= ?'); args.push(from); }
  if (to   !== null) { where.push('starts_at <= ?'); args.push(to); }
  if (source)        { where.push('source = ?');    args.push(source); }
  if (kind) {
    const kinds = Array.isArray(kind) ? kind : [kind];
    where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    args.push(...kinds);
  }
  const sql = `SELECT * FROM calendar_events${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY starts_at ASC LIMIT ?`;
  const r = await env.DB.prepare(sql).bind(...args, limit).all();
  return (r.results || []).map((e) => ({ ...e, attendees: safeJSON(e.attendees) }));
}

export async function readCalendarEvent(env, id) {
  const e = await env.DB.prepare('SELECT * FROM calendar_events WHERE id = ?').bind(id).first();
  if (!e) return null;
  return { ...e, attendees: safeJSON(e.attendees) };
}

// Upsert behaviour:
//   - If `id` provided + row exists → UPDATE that row.
//   - Else if (source, source_ref) row exists → UPDATE that row (keeps id stable).
//   - Else → INSERT new ce_<rand> id.
export async function upsertCalendarEvent(env, ev) {
  const t = now();
  const kind   = ev.kind   || 'meeting';
  const status = ev.status || 'confirmed';
  if (!CALENDAR_KINDS.includes(kind))      throw new Error(`unknown kind: ${kind}`);
  if (!CALENDAR_STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
  if (!ev.title)         throw new Error('title required');
  if (!ev.starts_at)     throw new Error('starts_at required');

  let existing = null;
  if (ev.id)                          existing = await env.DB.prepare('SELECT * FROM calendar_events WHERE id = ?').bind(ev.id).first();
  if (!existing && ev.source_ref)     existing = await env.DB.prepare('SELECT * FROM calendar_events WHERE source = ? AND source_ref = ?').bind(ev.source || 'manual', ev.source_ref).first();

  const row = {
    id:          ev.id || existing?.id || ('ce_' + uid()),
    kind,
    title:       ev.title,
    description: ev.description ?? null,
    starts_at:   ev.starts_at,
    ends_at:     ev.ends_at ?? null,
    all_day:     ev.all_day ? 1 : 0,
    status,
    source:      ev.source     || 'manual',
    source_ref:  ev.source_ref || null,
    link_url:    ev.link_url   || null,
    location:    ev.location   || null,
    attendees:   normaliseAttendees(ev.attendees),
    body:        ev.body       || null,
    platform:    ev.platform   || null,
    created_at:  existing?.created_at || t,
    updated_at:  t,
    created_by:  existing?.created_by || ev.created_by || ev.updated_by || 'operator',
    updated_by:  ev.updated_by || ev.created_by || 'operator',
  };

  if (existing) {
    await env.DB.prepare(
      `UPDATE calendar_events SET
         kind=?, title=?, description=?, starts_at=?, ends_at=?, all_day=?, status=?,
         source=?, source_ref=?, link_url=?, location=?, attendees=?, body=?, platform=?,
         updated_at=?, updated_by=?
       WHERE id=?`,
    ).bind(
      row.kind, row.title, row.description, row.starts_at, row.ends_at, row.all_day, row.status,
      row.source, row.source_ref, row.link_url, row.location, row.attendees, row.body, row.platform,
      row.updated_at, row.updated_by, row.id,
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO calendar_events
         (id, kind, title, description, starts_at, ends_at, all_day, status, source, source_ref,
          link_url, location, attendees, body, platform, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id, row.kind, row.title, row.description, row.starts_at, row.ends_at, row.all_day, row.status,
      row.source, row.source_ref, row.link_url, row.location, row.attendees, row.body, row.platform,
      row.created_at, row.updated_at, row.created_by, row.updated_by,
    ).run();
  }
  await logEvent(env, { kind: existing ? 'calendar_event_updated' : 'calendar_event_created', actor: row.updated_by, payload: { id: row.id, kind: row.kind, source: row.source } });
  return readCalendarEvent(env, row.id);
}

export async function deleteCalendarEvent(env, id) {
  await env.DB.prepare('DELETE FROM calendar_events WHERE id = ?').bind(id).run();
  await logEvent(env, { kind: 'calendar_event_deleted', payload: { id } });
}

// ─── Nyo pending messages (queued assistant turns) ──────────
// Background work (cron, hooks, AEO writer, image generator, etc.) queues
// messages here; the Chat component polls and injects them as assistant
// turns in the conversation. Clears the badge automatically once the
// operator opens the chat (existing hasUnseen flow).
export async function queueNyoMessage(env, { content, kind = 'system', ref_kind = null, ref_id = null, payload = null }) {
  if (!content) throw new Error('queueNyoMessage: content required');
  const id = 'nyo_' + uid().slice(0, 12);
  await env.DB.prepare(
    `INSERT INTO nyo_messages (id, content, kind, ref_kind, ref_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, content, kind, ref_kind, ref_id,
    payload ? JSON.stringify(payload) : null,
    now(),
  ).run();
  return { id };
}

export async function listPendingNyoMessages(env, { limit = 20 } = {}) {
  const r = await env.DB.prepare(
    `SELECT * FROM nyo_messages WHERE delivered_at IS NULL ORDER BY created_at ASC LIMIT ?`,
  ).bind(limit).all();
  return (r.results || []).map((m) => ({ ...m, payload: safeJSON(m.payload_json) }));
}

export async function markNyoMessageDelivered(env, id) {
  await env.DB.prepare('UPDATE nyo_messages SET delivered_at = ? WHERE id = ?').bind(now(), id).run();
}

export async function recentNyoMessages(env, { limit = 50 } = {}) {
  const r = await env.DB.prepare(
    `SELECT * FROM nyo_messages ORDER BY created_at DESC LIMIT ?`,
  ).bind(limit).all();
  return (r.results || []).map((m) => ({ ...m, payload: safeJSON(m.payload_json) }));
}

// ─── feature flags ─────────────────────────────────────────────
export async function listFlags(env, scope = null) {
  const sql = scope
    ? 'SELECT * FROM feature_flags WHERE scope = ? ORDER BY key'
    : 'SELECT * FROM feature_flags ORDER BY scope, key';
  const stmt = scope ? env.DB.prepare(sql).bind(scope) : env.DB.prepare(sql);
  const r = await stmt.all();
  return r.results || [];
}
export async function flagsAsObject(env) {
  const rows = await listFlags(env);
  return Object.fromEntries(rows.map((r) => [r.key, r.value === 1]));
}
export async function setFlag(env, key, value) {
  const t = now();
  const existing = await env.DB.prepare('SELECT 1 FROM feature_flags WHERE key = ?').bind(key).first();
  if (existing) {
    await env.DB.prepare(`UPDATE feature_flags SET value = ?, updated_at = ? WHERE key = ?`)
      .bind(value ? 1 : 0, t, key).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO feature_flags (key, value, scope, description, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(key, value ? 1 : 0, 'tool', null, t).run();
  }
  await logEvent(env, { kind: 'flag_toggled', payload: { key, value: !!value } });
}


// ─── finance (monthly cashflow calculator) ─────────────────────
// One row per ledger line. A month's running balance is computed by the reader:
// income rows add income_net, expense + draw rows subtract expense; the month's
// final balance is "stays in account". income_net = income_pretax * 1.18 (Ma'am)
// when a pre-VAT amount is entered; some incomes are entered net directly.
export const MAAM_RATE = 0.18;
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

export async function listFinanceEntries(env, { year = null } = {}) {
  const r = year
    ? await env.DB.prepare('SELECT * FROM finance_entries WHERE year=? ORDER BY month, position, id').bind(year).all()
    : await env.DB.prepare('SELECT * FROM finance_entries ORDER BY year, month, position, id').all();
  return r.results || [];
}

export async function createFinanceEntry(env, e = {}) {
  const id = uid(); const t = now();
  const year  = e.year  || new Date().getFullYear();
  const month = e.month || (new Date().getMonth() + 1);
  const kind  = e.kind || (e.income_net != null || e.income_pretax != null ? 'income' : 'expense');
  const pos   = e.position ?? (((await env.DB.prepare(
    'SELECT COALESCE(MAX(position),0)+1 AS n FROM finance_entries WHERE year=? AND month=?').bind(year, month).first())?.n) || 1);
  // net: explicit wins; else derive from pre-VAT amount; only meaningful for income.
  let income_net = null;
  if (kind === 'income') income_net = e.income_net != null ? round2(e.income_net)
    : (e.income_pretax != null ? round2(e.income_pretax * (1 + MAAM_RATE)) : null);
  await env.DB.prepare(
    `INSERT INTO finance_entries (id, year, month, position, kind, status, item, income_pretax, income_net, expense, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, year, month, pos, kind, e.status || '', e.item || '', e.income_pretax ?? null, income_net, e.expense ?? null, e.note ?? null, t, t).run();
  await logEvent(env, { kind: 'finance_entry_added', actor: e.actor || 'operator', payload: { id, year, month, item: e.item } });
  return env.DB.prepare('SELECT * FROM finance_entries WHERE id=?').bind(id).first();
}

export async function updateFinanceEntry(env, id, patch = {}) {
  const ex = await env.DB.prepare('SELECT * FROM finance_entries WHERE id=?').bind(id).first();
  if (!ex) throw new Error(`finance entry not found: ${id}`);
  const m = { ...ex, ...patch };
  // Recompute net: explicit income_net patch wins; else derive from a patched
  // pre-VAT amount; else keep existing. Non-income rows carry no net.
  let income_net = ex.income_net;
  if (m.kind !== 'income') income_net = null;
  else if ('income_net' in patch) income_net = patch.income_net;
  else if ('income_pretax' in patch) income_net = patch.income_pretax != null ? patch.income_pretax * (1 + MAAM_RATE) : null;
  income_net = round2(income_net);
  const t = now();
  await env.DB.prepare(
    `UPDATE finance_entries SET year=?, month=?, position=?, kind=?, status=?, item=?, income_pretax=?, income_net=?, expense=?, note=?, updated_at=? WHERE id=?`,
  ).bind(m.year, m.month, m.position, m.kind, m.status ?? '', m.item ?? '', m.income_pretax ?? null, income_net, m.expense ?? null, m.note ?? null, t, id).run();
  await logEvent(env, { kind: 'finance_entry_updated', actor: patch.actor || 'operator', payload: { id } });
  return env.DB.prepare('SELECT * FROM finance_entries WHERE id=?').bind(id).first();
}

export async function deleteFinanceEntry(env, id) {
  await env.DB.prepare('DELETE FROM finance_entries WHERE id=?').bind(id).run();
  await logEvent(env, { kind: 'finance_entry_deleted', actor: 'operator', payload: { id } });
}

// READ-ONLY SQL surface for the query_crm tool. ponytail: substring guard,
// not a real SQL parser. It's the operator's own agent on their own DB, so
// the only thing worth hiding is the API key in `settings`. Swap in a parser
// only if an untrusted caller ever hits this.
export async function queryCrmReadOnly(env, rawSql) {
  let sql = String(rawSql || '').trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(sql)) return { error: 'read-only: query must start with SELECT or WITH' };
  if (/;/.test(sql)) return { error: 'one statement only' };
  if (/\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex)\b/i.test(sql)) return { error: 'read-only: write/DDL keywords not allowed' };
  if (/\bsettings\b/i.test(sql)) return { error: 'settings table is off-limits' };
  try {
    const capped = /\blimit\b/i.test(sql) ? sql : sql + ' LIMIT 500';
    const r = await env.DB.prepare(capped).all();
    return { rows: r.results || [], count: (r.results || []).length };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
