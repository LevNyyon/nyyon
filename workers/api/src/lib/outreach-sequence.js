// Outreach · the cohort sequence — one set of messages per COHORT, personalised
// per recipient.
//
// A cohort is a group of people who share a reason to be approached, so the
// copy is written once for the group rather than generated per person. The
// only per-person variation is substitution ({first_name}, {company}, …) and
// which language variant they get.
//
// This module is pure: parse, resolve a language, substitute, and report what
// is missing. It reads no tables, calls no model, and sends nothing — so the
// same rendering can be used to preview, to validate before go-live, and to
// produce the text the sender actually transmits, with no chance of the three
// disagreeing.

// Every variable a sequence may use. Deliberately small and concrete: each one
// maps to a field we actually hold, so "what can I write?" has one answer.
export const VARIABLES = {
  first_name: (l) => String(l?.name || '').trim().split(/\s+/)[0] || '',
  name: (l) => String(l?.name || '').trim(),
  company: (l) => String(l?.company || '').trim(),
  position: (l) => String(l?.position || '').trim(),
  country: (l) => String(l?.country || '').trim(),
};
export const VARIABLE_NAMES = Object.keys(VARIABLES);

const TOKEN = /\{([a-z_]+)\}/g;

// Which surface a step goes out on. Only WhatsApp is actually wired to a
// sender; the others are selectable so a flow can be designed ahead of the
// plumbing, and the engine refuses them out loud rather than pretending.
export const CHANNELS = ['whatsapp', 'linkedin', 'email'];
export const WIRED_CHANNELS = ['whatsapp'];

// The condition that decides whether a step fires at all. The flow stays a
// straight line — a trigger can skip a step, never fork it.
//   no_reply — skip (and end the run) if they have answered. The default, and
//              the same rule the sender enforces globally.
//   always   — send regardless, for a courtesy closer you want delivered even
//              to someone mid-conversation.
export const TRIGGERS = ['no_reply', 'always'];

export function parseSequence(raw) {
  let src = raw;
  if (typeof raw === 'string') { try { src = JSON.parse(raw); } catch { src = null; } }
  const steps = Array.isArray(src?.steps) ? src.steps : [];
  return {
    default_language: String(src?.default_language || 'en').toLowerCase(),
    steps: steps.map((s, i) => ({
      // Step 0 goes as soon as it is approved; later steps wait from the
      // previous send. A missing delay must not collapse a follow-up onto the
      // opener, so anything after the first defaults to a real gap.
      delay_hours: Number.isFinite(Number(s?.delay_hours)) ? Math.max(0, Number(s.delay_hours)) : (i === 0 ? 0 : 72),
      channel: CHANNELS.includes(s?.channel) ? s.channel : 'whatsapp',
      trigger: TRIGGERS.includes(s?.trigger) ? s.trigger : 'no_reply',
      bodies: (s?.bodies && typeof s.bodies === 'object') ? s.bodies : {},
    })).filter((s) => Object.values(s.bodies).some((b) => String(b || '').trim())),
  };
}

export function serializeSequence(seq) {
  const parsed = parseSequence(seq);
  return JSON.stringify(parsed);
}

// Which language a given prospect should receive. An explicit per-lead override
// wins; otherwise Israel gets Hebrew and everyone else the sequence default.
// Falls back to whatever variant actually exists, so a half-translated sequence
// still sends rather than silently dropping someone.
export function languageFor(lead, seq) {
  const parsed = parseSequence(seq);
  const explicit = String(lead?.outreach_lang || '').trim().toLowerCase();
  const guessed = /israel/i.test(String(lead?.country || '')) ? 'he' : parsed.default_language;
  return { preferred: explicit || guessed, fallback: parsed.default_language };
}

function pickBody(step, lead, seq) {
  const { preferred, fallback } = languageFor(lead, seq);
  const has = (k) => String(step.bodies?.[k] || '').trim();
  return has(preferred) ? { body: step.bodies[preferred], lang: preferred }
    : has(fallback) ? { body: step.bodies[fallback], lang: fallback }
    : (() => {
        const first = Object.keys(step.bodies).find((k) => has(k));
        return first ? { body: step.bodies[first], lang: first } : { body: '', lang: null };
      })();
}

// Substitute one step for one prospect. `missing` lists variables the template
// asks for that this person has no value for — the caller must treat a
// non-empty `missing` as "cannot send", never as "send with a gap in it".
export function renderStep(step, lead, seq) {
  const { body, lang } = pickBody(step, lead, seq);
  return { ...renderBody(body, lead), lang };
}

// Substitute one piece of copy for one prospect. Split out of renderStep so a
// per-person edit made in the cohort sheet goes through the SAME substitution
// and the same "missing" reporting as the cohort's own copy — an override that
// rendered by different rules could ship a raw {company} to a real prospect.
export function renderBody(body, lead) {
  const missing = new Set();
  const unknown = new Set();
  const text = String(body || '').replace(TOKEN, (whole, key) => {
    const get = VARIABLES[key];
    if (!get) { unknown.add(key); return whole; }
    const v = get(lead);
    if (!v) { missing.add(key); return whole; }
    return v;
  });
  return { text, missing: [...missing], unknown: [...unknown] };
}

// Render the whole sequence for one prospect. `blocked` is the single question
// the go-live check asks: is there any step this person cannot receive cleanly?
export function renderSequence(seq, lead) {
  const parsed = parseSequence(seq);
  const steps = parsed.steps.map((s, i) => ({
    index: i, delay_hours: s.delay_hours, channel: s.channel, trigger: s.trigger,
    ...renderStep(s, lead, parsed),
  }));
  const missing = [...new Set(steps.flatMap((s) => s.missing))];
  const unknown = [...new Set(steps.flatMap((s) => s.unknown))];
  return {
    steps,
    length: steps.length,
    missing,
    unknown,
    blocked: !parsed.steps.length
      ? 'this cohort has no message sequence yet'
      : missing.length
        ? `missing ${missing.map((m) => m.replace(/_/g, ' ')).join(', ')}`
        : unknown.length
          ? `unknown variable${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`
          : null,
  };
}

// Static check of the template itself, independent of any recipient — used by
// the editor so a typo like {firstname} is caught while writing, not at send.
export function validateSequence(seq) {
  const parsed = parseSequence(seq);
  const unknown = new Set();
  const used = new Set();
  for (const s of parsed.steps) {
    for (const body of Object.values(s.bodies)) {
      let m;
      TOKEN.lastIndex = 0;
      while ((m = TOKEN.exec(String(body || ''))) !== null) {
        if (VARIABLES[m[1]]) used.add(m[1]); else unknown.add(m[1]);
      }
    }
  }
  const languages = [...new Set(parsed.steps.flatMap((s) => Object.keys(s.bodies)))];
  // A step on a channel nothing can send is a design placeholder, not a fault —
  // it is reported so the editor can say so, and the engine stops on it.
  const unwired = [...new Set(parsed.steps.map((s) => s.channel).filter((c) => !WIRED_CHANNELS.includes(c)))];
  return {
    steps: parsed.steps.length,
    languages,
    unwired_channels: unwired,
    variables_used: [...used],
    unknown_variables: [...unknown],
    ok: parsed.steps.length > 0 && unknown.size === 0,
  };
}
