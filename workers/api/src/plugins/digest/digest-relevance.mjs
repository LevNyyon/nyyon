// Digest plugin — the consideration layer. Ported from
// workers/api/src/lib/digest-relevance.js under the plugin capability
// contract: every function takes `api` first; this file imports NOTHING.
//
// Learns from what the operator DISMISSES and feeds it back into the digest's
// interest filter, so the same uninteresting items stop showing up.
//
// The digest generator already weighs the `plugin-digest-interests`
// knowledge doc when deciding which items to surface vs drop (see digest.mjs).
// The gap was that the doc was static. This closes the loop: it reads
// recently-dismissed items, distills the patterns behind them through the
// `llm` gateway, and rewrites a "Learned from your dismissals" section of that
// same doc. No new surface — the existing generator consumes the improved doc
// on its next run.
//
// Reaches the model ONLY through the `llm` gateway; the rule set lives in the
// editable knowledge doc; every learning pass logs.
//
// State note (port): the host version tracked "last learn at" in the
// feature_flags table. feature_flags is host-owned and SELECT-only for
// plugins, so the marker now lives on the activity bus instead: every
// completed learn pass logs `digest_learn_pass` (which api.log lands as kind
// 'plugin_digest_digest_learn_pass'), and the next run reads the newest
// such row from the declared `events` host_read. Same semantics, no host
// table write.

const now = () => Date.now();

const DOC_SLUG = 'plugin-digest-interests';
const LEARN_MARK = '\n\n## Learned — auto-tuned from your dismissals\n';
// api.log prefixes with plugin_digest_ — this is the stored `kind`.
const LEARN_PASS_EVENT_KIND = 'plugin_digest_digest_learn_pass';

const LEARN_SYSTEM = `You maintain the "avoid" rules for an operator's morning digest.

You are given (a) the operator's current interest profile, and (b) a list of digest
items they recently DISMISSED without acting on (a strong signal they don't want to
see that kind of thing). Distill the dismissals into a SHORT list of concrete,
general patterns the digest should stop surfacing — by topic, source, sender type,
or shape (e.g. "automated delivery/OTP notifications", "group banter with no ask",
"newsletters about X"). Be specific enough to act on, general enough to catch
future look-alikes. Do NOT contradict things the profile says ARE wanted, and do
NOT suppress anything that looks like a real business opportunity, a client
message, or a direct question to the operator.

Return STRICT JSON: {"avoid":["pattern 1","pattern 2", ...]}  (max 12, most common first).`;

// How many NEW dismissals (since the last learn) before it's worth a pass.
const MIN_NEW_DISMISSALS = 6;

// The cheap utility model for the distillation pass. The host read the
// `llm-models` knowledge doc (writer_small field) through loadModelConfig;
// the plugin reads the same doc via a declared requires.knowledge grant.
// A missing/unparseable doc simply omits `model` so the llm gateway's own
// default applies (model choice stays in knowledge, never a code literal).
async function writerSmallModel(api) {
  try {
    const doc = await api.knowledge('llm-models');
    const m = String(doc?.body || '').match(/```json\s*([\s\S]*?)```/);
    const src = m ? JSON.parse(m[1]) : {};
    const v = String(src.writer_small ?? '').trim();
    return v && v.length <= 120 && !/\s{2,}|\n/.test(v) ? v : undefined;
  } catch { return undefined; }
}

// When did the last learn pass run? Newest learn-pass row on the activity
// bus (events is a declared SELECT-only host_read). 0 when never.
async function lastLearnAt(api) {
  try {
    const row = await api.db.prepare(
      `SELECT created_at FROM events WHERE kind = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(LEARN_PASS_EVENT_KIND).first();
    return Number(row?.created_at || 0);
  } catch { return 0; }
}

export async function learnFromDismissals(api, { force = false, lookbackDays = 21 } = {}) {
  const lastLearn = await lastLearnAt(api);
  const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
  const since = Date.now() - lookbackMs;

  // Negative signal: dismissed (read), not starred, not acted. `read_at` is set
  // when the operator hits ✕. Starred items are explicit keeps — never learn
  // "avoid" from them.
  let dismissed = [];
  try {
    dismissed = (await api.db.prepare(
      `SELECT kind, title, summary, read_at FROM plugin_digest_items
       WHERE read_at IS NOT NULL AND starred = 0 AND created_at >= ?
       ORDER BY read_at DESC LIMIT 80`,
    ).bind(since).all()).results || [];
  } catch { return { ok: false, error: 'digest_items unavailable' }; }

  const newDismissals = dismissed.filter((d) => (d.read_at || 0) > lastLearn).length;
  if (!force && newDismissals < MIN_NEW_DISMISSALS) {
    return { ok: true, learned: false, new_dismissals: newDismissals, need: MIN_NEW_DISMISSALS };
  }
  if (!dismissed.length) return { ok: true, learned: false, new_dismissals: 0 };

  const doc = await api.knowledge(DOC_SLUG);
  const base = String(doc?.body || '').split(LEARN_MARK)[0].trimEnd();
  const profileForModel = base;
  const items = dismissed.slice(0, 60).map((d, i) => `[${i}] (${d.kind}) ${String(d.title || '').slice(0, 140)}${d.summary ? ' — ' + String(d.summary).slice(0, 120) : ''}`).join('\n');

  const model = await writerSmallModel(api);
  let out;
  try {
    out = await api.gateway('llm', 'json', {
      system: LEARN_SYSTEM,
      prompt: `CURRENT INTEREST PROFILE:\n${profileForModel}\n\nRECENTLY DISMISSED (${dismissed.length}):\n${items}\n\nProduce the JSON.`,
      model, max_tokens: 900,
    });
  } catch (e) {
    return { ok: false, error: `llm: ${String(e?.message || e)}` };
  }
  const avoid = Array.isArray(out?.avoid) ? out.avoid.filter((s) => typeof s === 'string' && s.trim()).slice(0, 12) : [];
  if (!avoid.length) {
    // Advance the marker even with nothing learned — same role as the host's
    // flag write: don't re-run the LLM on the same dismissal set tomorrow.
    await api.log('digest_learn_pass', { learned: false, from_dismissals: dismissed.length });
    return { ok: true, learned: false, new_dismissals: newDismissals };
  }

  const learnedSection = `_Auto-maintained from items you dismissed. The generator treats these as low-interest; edit or delete freely — they'll be re-derived on the next pass._\n\n${avoid.map((a) => `- ${a}`).join('\n')}`;
  const newBody = `${base}${LEARN_MARK}${learnedSection}\n`;
  await api.saveKnowledge(DOC_SLUG, { title: doc?.title || 'Nyyon — what counts as \'of interest\' for the digest', body: newBody });
  await api.log('digest_learn_pass', { learned: true, avoid_count: avoid.length });
  await api.log('digest_interests_learned', { avoid_count: avoid.length, from_dismissals: dismissed.length });
  return { ok: true, learned: true, avoid, from_dismissals: dismissed.length };
}
