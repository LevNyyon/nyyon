// Digest consideration layer (nyyon-lite) — learns from what the operator
// DISMISSES and feeds it back into the digest's interest filter, so the same
// uninteresting items stop showing up.
//
// The digest generator already weighs the `nyyon-digest-interests` knowledge doc
// when deciding which items to surface vs drop (see digest.js). The gap was that
// the doc was static. This closes the loop: it reads recently-dismissed items,
// distills the patterns behind them through the `llm` gateway, and rewrites a
// "Learned from your dismissals" section of that same doc. No new surface — the
// existing generator consumes the improved doc on its next run.
//
// Reaches the model ONLY through the `llm` gateway; the rule set lives in the
// editable knowledge doc; every learning pass logs.

import { now } from './util.js';
import { readKnowledge, writeKnowledge, logEvent, flagsAsObject, setFlag } from './db.js';
import { loadModelConfig } from './model-config.js';
import { callGateway } from '../gateways/index.js';

const DOC_SLUG = 'digest-interests';
const LEARN_MARK = '\n\n## Learned — auto-tuned from your dismissals\n';
const LAST_LEARN_FLAG = 'digest.lastLearnAt';

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

export async function learnFromDismissals(env, { force = false, lookbackDays = 21 } = {}) {
  const flags = await flagsAsObject(env);
  const lastLearn = Number(flags[LAST_LEARN_FLAG] || 0);
  const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
  const since = Date.now() - lookbackMs;

  // Negative signal: dismissed (read), not starred, not acted. `read_at` is set
  // when the operator hits ✕. Starred items are explicit keeps — never learn
  // "avoid" from them.
  let dismissed = [];
  try {
    dismissed = (await env.DB.prepare(
      `SELECT kind, title, summary, read_at FROM digest_items
       WHERE read_at IS NOT NULL AND starred = 0 AND created_at >= ?
       ORDER BY read_at DESC LIMIT 80`,
    ).bind(since).all()).results || [];
  } catch { return { ok: false, error: 'digest_items unavailable' }; }

  const newDismissals = dismissed.filter((d) => (d.read_at || 0) > lastLearn).length;
  if (!force && newDismissals < MIN_NEW_DISMISSALS) {
    return { ok: true, learned: false, new_dismissals: newDismissals, need: MIN_NEW_DISMISSALS };
  }
  if (!dismissed.length) return { ok: true, learned: false, new_dismissals: 0 };

  const doc = await readKnowledge(env, DOC_SLUG);
  const base = String(doc?.body || '').split(LEARN_MARK)[0].trimEnd();
  const profileForModel = base.slice(0, 2500);
  const items = dismissed.slice(0, 60).map((d, i) => `[${i}] (${d.kind}) ${String(d.title || '').slice(0, 140)}${d.summary ? ' — ' + String(d.summary).slice(0, 120) : ''}`).join('\n');

  const model = (await loadModelConfig(env)).writer_small;
  let out;
  try {
    out = await callGateway(env, 'llm', 'json', {
      system: LEARN_SYSTEM,
      prompt: `CURRENT INTEREST PROFILE:\n${profileForModel}\n\nRECENTLY DISMISSED (${dismissed.length}):\n${items}\n\nProduce the JSON.`,
      model, max_tokens: 900,
    });
  } catch (e) {
    return { ok: false, error: `llm: ${String(e?.message || e)}` };
  }
  const avoid = Array.isArray(out?.avoid) ? out.avoid.filter((s) => typeof s === 'string' && s.trim()).slice(0, 12) : [];
  if (!avoid.length) { await setFlag(env, LAST_LEARN_FLAG, now()); return { ok: true, learned: false, new_dismissals: newDismissals }; }

  const learnedSection = `_Auto-maintained from items you dismissed. The generator treats these as low-interest; edit or delete freely — they'll be re-derived on the next pass._\n\n${avoid.map((a) => `- ${a}`).join('\n')}`;
  const newBody = `${base}${LEARN_MARK}${learnedSection}\n`;
  await writeKnowledge(env, { slug: DOC_SLUG, title: doc?.title || 'Nyyon — what counts as \'of interest\' for the digest', body: newBody, parent_slug: doc?.parent_slug });
  await setFlag(env, LAST_LEARN_FLAG, now());
  await logEvent(env, { kind: 'digest_interests_learned', payload: { avoid_count: avoid.length, from_dismissals: dismissed.length } });
  return { ok: true, learned: true, avoid, from_dismissals: dismissed.length };
}
