// Digest plugin: signal priority, the reasoning layer over digest cards.
// Under the plugin capability contract (api first, imports NOTHING).
//
// A scored card gets a 0-100 relevance score plus a stated reason, so the
// brief reads most-relevant first and background noise last. The rubric,
// the scoring prompt, which kinds get scored, and every threshold live in
// the plugin-digest-signal-priority knowledge doc; the score maps onto the
// digest's urgency groups (high / mid / low) and the raw score + reason
// persist on the item's meta. The operator's interest profile
// (plugin-digest-interests) rides along in the prompt, and taste_rules grow
// from his comments on scores.
//
// Snooze lives here too: "keep this out of the brief for a while" keyed the
// same way digest.mjs keys it (a news card mutes its outlet, a card derived
// from a host row mutes that row, anything else mutes itself). The key
// builder is duplicated from digest.mjs on purpose: lib files may not import
// each other.
// Tables: plugin_digest_items, plugin_digest_signal_snoozes (own).
// Gateway: llm(text).

const now = () => Date.now();

const DOC_SLUG = 'plugin-digest-signal-priority';

const DEFAULT_PROMPT = `You score ONE card from an operator's morning digest for how much of their attention it deserves today, 0-100.

Score bands:
- 70-100 act on it: a concrete, timely development the operator should react to or that directly touches what they track (their named topics, markets, products, competitors).
- 40-69 worth knowing: relevant background, a real development in an adjacent area, something to skim.
- 0-39 can wait: evergreen filler, listicles, reviews, vendor press releases, coincidental keyword matches, anything that gives no reason to act.

Judge what the card gives the operator to DO or LEARN, not how loud the headline is. Return STRICT JSON: {"score": <0-100>, "reason": "<one short sentence naming why it matters or why it does not>"}`;

const DEFAULT_FEEDBACK_PROMPT = 'You maintain a short list of durable TASTE rules describing how an operator wants their digest cards prioritized. Given a card, the scorer\'s verdict, and the operator\'s comment on that verdict, extract at most 2 NEW durable rules (what they value, what bores them, how to weigh kinds of news), merge with the existing rules, drop duplicates and one-off gripes, keep under {max} rules, each short and imperative. Return STRICT JSON: {"rules":["..."]}';

const DEFAULTS = {
  prompt: DEFAULT_PROMPT,
  urgency_thresholds: { high: 70, mid: 40 },
  // which card kinds the sweep scores; calendar cards keep their clock-based
  // urgency and are left alone
  score_kinds: ['news'],
  batch_limit: 10,
  taste_rules: [],
  max_taste_rules: 20,
  feedback_prompt: DEFAULT_FEEDBACK_PROMPT,
  // 'snooze' on a card mutes its key for this long
  snooze_days: 7,
};

const seedBody = (cfg = DEFAULTS) => `# Signal priority

The reasoning rubric behind digest ordering: every card of a scored kind is
scored 0-100 for the attention it deserves, with a one-line reason, and the
score maps to the brief's urgency groups. score_kinds picks which kinds get
scored (calendar cards keep their clock-based urgency). taste_rules grow
from the operator's comments on scores (the chip's comment box) and bind
every future score. snooze_days is how long a snoozed card's key stays
muted. Edit anything here; no deploy needed.

\`\`\`json
${JSON.stringify(cfg, null, 2)}
\`\`\`
`;

export async function signalPriorityCfg(api) {
  let doc = null;
  try { doc = await api.knowledge(DOC_SLUG); } catch { doc = null; }
  if (!doc) {
    await api.saveKnowledge(DOC_SLUG, { title: 'Signal priority', body: seedBody() }).catch(() => {});
    doc = { body: seedBody() };
  }
  try {
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    const parsed = m ? JSON.parse(m[1]) : null;
    if (parsed && typeof parsed === 'object') return { ...DEFAULTS, ...parsed };
  } catch { /* malformed edit must not break scoring: defaults win */ }
  return DEFAULTS;
}

// The operator's interest profile, when present, steers the scorer.
async function interestProfile(api) {
  try {
    const doc = await api.knowledge('plugin-digest-interests');
    const body = String(doc?.body || '').trim();
    return body ? `\n\nOPERATOR'S INTEREST PROFILE (weigh the card against this):\n${body.slice(0, 4000)}` : '';
  } catch { return ''; }
}

// Score ONE digest item: the llm rubric + interest profile + taste rules.
// Persists meta.priority / meta.priority_reason, remaps the item's urgency,
// logs signal_scored. Idempotent: rescoring overwrites.
export async function scoreSignalItem(api, id) {
  const cfg = await signalPriorityCfg(api);
  const item = await api.db.prepare(
    'SELECT id, kind, title, summary, source_label, urgency, meta_json FROM plugin_digest_items WHERE id = ?',
  ).bind(id).first();
  if (!item) return { ok: false, error: 'digest item not found' };
  let meta = {};
  try { meta = JSON.parse(item.meta_json || '{}'); } catch { meta = {}; }

  const taste = Array.isArray(cfg.taste_rules) && cfg.taste_rules.length
    ? `\n\nOPERATOR TASTE, learned from their feedback. Weigh these over the generic bands:\n${cfg.taste_rules.map((r) => '- ' + r).join('\n')}`
    : '';
  const profile = await interestProfile(api);
  const raw = await api.gateway('llm', 'text', {
    system: cfg.prompt + profile + taste,
    prompt: `Kind: ${item.kind}
Source: ${item.source_label || '?'}
Title: ${item.title}
Summary: ${String(item.summary || '').slice(0, 600)}`,
    max_tokens: 300,
  });
  const s = String(raw || '');
  let score = 50, reason = 'unscored';
  try {
    const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    score = Math.max(0, Math.min(100, Number(j.score) || 0));
    reason = String(j.reason || '').slice(0, 240) || 'no reason given';
  } catch { return { ok: false, error: 'scorer returned no parseable verdict' }; }

  const th = cfg.urgency_thresholds || DEFAULTS.urgency_thresholds;
  const urgency = score >= (Number(th.high) || 70) ? 1 : score >= (Number(th.mid) || 40) ? 2 : 3;

  meta.priority = score;
  meta.priority_reason = reason;
  meta.priority_at = now();
  await api.db.prepare('UPDATE plugin_digest_items SET urgency = ?, meta_json = ? WHERE id = ?')
    .bind(urgency, JSON.stringify(meta), id).run();
  await api.log('signal_scored', { id, score, urgency });
  return { ok: true, id, score, urgency, reason };
}

// Score every unread, unscored card of a scored kind (bounded per run by
// batch_limit). Safe to call spuriously; already-scored items are skipped.
export async function sweepSignalPriorities(api, { limit } = {}) {
  const cfg = await signalPriorityCfg(api);
  const cap = Math.max(1, Math.min(25, Number(limit) || Number(cfg.batch_limit) || 10));
  const kinds = (Array.isArray(cfg.score_kinds) ? cfg.score_kinds : DEFAULTS.score_kinds)
    .map((k) => String(k)).filter(Boolean);
  if (!kinds.length) return { ok: true, scored: 0, pending: 0, results: [] };
  // Unscored selected in SQL, so no recency window can strand old cards:
  // every unread card is eventually scored, newest first.
  const rows = (await api.db.prepare(
    `SELECT id FROM plugin_digest_items
     WHERE kind IN (${kinds.map(() => '?').join(',')}) AND read_at IS NULL
       AND json_extract(meta_json, '$.priority_at') IS NULL
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(...kinds, cap).all()).results || [];
  const out = [];
  for (const r of rows) {
    out.push(await scoreSignalItem(api, r.id).catch((e) => ({ ok: false, id: r.id, error: String(e?.message || e) })));
  }
  const scored = out.filter((x) => x.ok).length;
  if (scored) await api.log('signals_prioritized', { scored, of: rows.length });
  return { ok: true, scored, pending: rows.length, results: out };
}

// Operator comment on a score: durable taste rules, then an immediate
// rescore under the updated rubric so the effect shows at once.
export async function distillPriorityFeedback(api, id, comment) {
  const text = String(comment || '').trim();
  if (!text) return { ok: false, error: 'comment required' };
  const cfg = await signalPriorityCfg(api);
  const item = await api.db.prepare(
    'SELECT id, kind, title, source_label, meta_json FROM plugin_digest_items WHERE id = ?',
  ).bind(id).first();
  if (!item) return { ok: false, error: 'digest item not found' };
  let meta = {};
  try { meta = JSON.parse(item.meta_json || '{}'); } catch { meta = {}; }

  const raw = await api.gateway('llm', 'text', {
    system: (cfg.feedback_prompt || DEFAULT_FEEDBACK_PROMPT).replace('{max}', String(cfg.max_taste_rules || 20)),
    prompt: `EXISTING RULES:\n${JSON.stringify(cfg.taste_rules || [])}\n\nCARD (${item.kind}, ${item.source_label || '?'}): ${item.title}\nSCORER'S VERDICT: P${meta.priority ?? '?'}: ${meta.priority_reason || '?'}\n\nOPERATOR'S COMMENT:\n"${text.slice(0, 600)}"`,
    max_tokens: 600,
  });
  const sRaw = String(raw || '');
  let rules;
  try {
    const j = JSON.parse(sRaw.slice(sRaw.indexOf('{'), sRaw.lastIndexOf('}') + 1));
    rules = (Array.isArray(j.rules) ? j.rules : []).filter((r) => typeof r === 'string' && r.trim())
      .slice(0, Number(cfg.max_taste_rules) || 20);
  } catch { return { ok: false, error: 'feedback distiller returned no parseable rules' }; }

  const next = { ...cfg, taste_rules: rules };
  await api.saveKnowledge(DOC_SLUG, { title: 'Signal priority', body: seedBody(next) });
  await api.log('signal_feedback', { id, comment: text.slice(0, 240), rules: rules.length });
  const rescored = await scoreSignalItem(api, id);
  return { ok: true, rules: rules.length, rescored };
}

// ── snooze: keep this out of the brief for a while ──────────────
// Same key shape as digest.mjs's digestSnoozeKey (duplicated by contract).
export function snoozeKeyFor(item) {
  if (!item) return null;
  const label = String(item.source_label || '').trim().toLowerCase();
  if (item.kind === 'news' && label) return 'source:' + label;
  if (item.ref_kind && item.ref_id) return `ref:${item.ref_kind}:${item.ref_id}`;
  return 'item:' + item.id;
}

// Is this key muted right now?
export async function isSnoozed(api, key) {
  if (!key) return null;
  const row = await api.db.prepare(
    'SELECT key, until FROM plugin_digest_signal_snoozes WHERE until > ? AND key = ? LIMIT 1',
  ).bind(now(), key).first().catch(() => null);
  return row || null;
}

// Snooze the card's key for snooze_days: archives the card and its unread
// siblings on the same key (deps.archiveItemsByKey from ./digest.mjs, wired
// by the calling tool) and keeps new arrivals on that key out of the brief
// until the snooze expires.
export async function snoozeItem(api, id, deps = {}) {
  const cfg = await signalPriorityCfg(api);
  const item = await api.db.prepare(
    'SELECT id, kind, ref_kind, ref_id, source_label, title FROM plugin_digest_items WHERE id = ?',
  ).bind(id).first();
  if (!item) return { ok: false, error: 'digest item not found' };
  const key = snoozeKeyFor(item);
  if (!key) return { ok: false, error: 'nothing identifies this card' };
  const days = Number(cfg.snooze_days) || 7;
  const until = now() + days * 24 * 60 * 60 * 1000;
  const label = key.startsWith('source:') ? (item.source_label || null) : String(item.title || '').slice(0, 120);
  await api.db.prepare(
    `INSERT INTO plugin_digest_signal_snoozes (key, until, label, reason, created_at) VALUES (?, ?, ?, 'snoozed by the operator', ?)
     ON CONFLICT(key) DO UPDATE SET until = MAX(plugin_digest_signal_snoozes.until, excluded.until), label = excluded.label`,
  ).bind(key, until, label, now()).run();
  const archived = typeof deps.archiveItemsByKey === 'function'
    ? await deps.archiveItemsByKey(api, key, { except_id: id })
    : 0;
  await api.db.prepare('UPDATE plugin_digest_items SET read_at = ? WHERE id = ?').bind(now(), id).run();
  await api.log('signal_snoozed', { id, key, days, until, archived: archived + 1 });
  return { ok: true, key, until, days, archived: archived + 1 };
}

// Undo: wake a key again. Identify it by the card that was snoozed or by the
// key itself (e.g. "source:techcrunch").
export async function unsnoozeItem(api, { digest_id = null, key = null } = {}) {
  let k = key ? String(key) : null;
  if (!k && digest_id) {
    const item = await api.db.prepare(
      'SELECT id, kind, ref_kind, ref_id, source_label FROM plugin_digest_items WHERE id = ?',
    ).bind(digest_id).first();
    if (!item) return { ok: false, error: 'digest item not found' };
    k = snoozeKeyFor(item);
  }
  if (!k) return { ok: false, error: 'pass digest_id or key' };
  const r = await api.db.prepare('DELETE FROM plugin_digest_signal_snoozes WHERE key = ?').bind(k).run();
  await api.log('signal_unsnoozed', { key: k, removed: r.meta?.changes || 0 });
  return { ok: true, key: k, removed: r.meta?.changes || 0 };
}
