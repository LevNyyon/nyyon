// GTM plugin lib — outreach cadence. Ported from workers/api/src/lib/
// outreach-cadence.js: the editable rules for the automated queue, and for
// when a conversation counts as dead. Reads/writes ONE knowledge doc (the
// plugin's own, re-slugged) and hands back plain numbers.
//
// Only the two doc entry points live here (read_cadence / save_cadence tools).
// The window math (zonedParts, withinWindow, …) is duplicated inside
// outreach-cohorts.mjs — pack libs import nothing, not even each other.

const SLUG = 'plugin-gtm-outreach-cohort-cadence';

// Defaults are deliberately conservative: follow-ups spread over two weeks,
// a small daily ceiling, and business hours only. The doc overrides all of it.
export const CADENCE_DEFAULTS = {
  // hours to wait before each FOLLOW-UP (step 0 is the first touch and goes as
  // soon as it is due). Fewer entries than bubbles → the last value repeats.
  step_delays_hours: [72, 96, 168],
  max_sends_per_day: 20,
  min_gap_minutes: 8,
  quiet_start_hour: 9,   // sends allowed from this hour…
  quiet_end_hour: 19,    // …until this one, operator local time
  weekdays_only: true,
  timezone: 'Asia/Jerusalem',
  dead_after_days: 21,
  // Every individual message waits for the operator to approve it, rather than
  // go-live approving a person's whole ladder in one press. Defaults ON: the
  // safe direction for a mistake here is "nothing sent", never "sent unread".
  require_approval: true,
  // Ceiling on a message the operator writes by hand in the cohort sheet.
  max_message_chars: 4000,
};

const NUMERIC = ['max_sends_per_day', 'min_gap_minutes', 'quiet_start_hour', 'quiet_end_hour', 'dead_after_days', 'max_message_chars'];

function coerce(src) {
  const out = { ...CADENCE_DEFAULTS };
  if (!src || typeof src !== 'object') return out;
  for (const k of NUMERIC) {
    const v = Number(src[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
  }
  if (Array.isArray(src.step_delays_hours)) {
    const arr = src.step_delays_hours.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    if (arr.length) out.step_delays_hours = arr;
  }
  if (typeof src.weekdays_only === 'boolean') out.weekdays_only = src.weekdays_only;
  if (typeof src.require_approval === 'boolean') out.require_approval = src.require_approval;
  if (typeof src.timezone === 'string' && src.timezone.trim()) out.timezone = src.timezone.trim();
  // A window that cannot open would silently freeze the queue forever — treat
  // it as unset rather than letting it look like "nothing is due".
  if (out.quiet_end_hour <= out.quiet_start_hour) {
    out.quiet_start_hour = CADENCE_DEFAULTS.quiet_start_hour;
    out.quiet_end_hour = CADENCE_DEFAULTS.quiet_end_hour;
  }
  return out;
}

// Read the cadence. Never throws. (The host version seeded the doc on first
// read via its knowledge helper; here loading falls back to defaults when the
// doc is absent, and the save path creates it.)
export async function loadCohortCadence(api) {
  try {
    const doc = await api.knowledge(SLUG);
    if (!doc) return { cadence: { ...CADENCE_DEFAULTS }, source: 'defaults', notes: '' };
    const body = String(doc.body || '');
    const m = body.match(/```json\s*([\s\S]*?)```/);
    let parsed = null;
    if (m) { try { parsed = JSON.parse(m[1]); } catch { parsed = null; } }
    const idx = body.indexOf('\n---\n');
    return {
      cadence: coerce(parsed),
      source: parsed ? 'doc' : 'defaults',
      notes: (idx >= 0 ? body.slice(idx + 5) : '').trim(),
    };
  } catch {
    return { cadence: { ...CADENCE_DEFAULTS }, source: 'defaults', notes: '' };
  }
}

// Merge a patch into the doc's json block, leaving the prose untouched.
export async function saveCohortCadence(api, patch = {}) {
  const cur = await loadCohortCadence(api);
  const next = coerce({ ...cur.cadence, ...patch });
  const doc = await api.knowledge(SLUG).catch(() => null);
  const body = String(doc?.body || '');
  const json = JSON.stringify(next, null, 2);
  const nextBody = body.match(/```json\s*([\s\S]*?)```/)
    ? body.replace(/```json\s*[\s\S]*?```/, '```json\n' + json + '\n```')
    : `Outreach · Queue cadence.\n\n\`\`\`json\n${json}\n\`\`\`\n\n---\n${cur.notes}`;
  await api.saveKnowledge(SLUG, { title: 'Outreach · Queue cadence', body: nextBody });
  await api.log('outreach_cadence_updated', next);
  return { cadence: next, source: 'doc' };
}
