// Outreach · Cohorts — the groups we decided to approach, and the automated
// ladder that walks each one forward until they answer.
//
// The copy is NOT written here and is never written unattended: it is the
// COHORT's own sequence, authored once for the group and personalised per
// recipient by variables and language variant. Step 0 is the first touch, step
// 1 the first follow-up, and so on. When the steps run out the prospect leaves
// the cohort. So every automated message is one the operator already approved.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a prospect who has said anything back
// is out of the automation, permanently — and that is re-checked in the moment
// before each send, not merely when the send was scheduled. A follow-up scheduled
// three days ago must not land on someone who replied yesterday.
//
// Sending is gated on the `outreach.live` feature flag. Until it is true the
// tick does everything except send, recording what it WOULD have sent.

import { now } from './util.js';
import { logEvent, flagsAsObject } from './db.js';
import { sendText } from './whatsapp.js';
import { getLead } from './gtm.js';
import { threadFacts, conversationStatesFor } from './outreach-wa.js';
import { loadCohortCadence, withinWindow, nextWindowOpening, effectiveCadence, zonedLabel, zonedYmd, parseWindows } from './outreach-cadence.js';
import { parseSequence, serializeSequence, renderSequence, renderBody, validateSequence, WIRED_CHANNELS, VARIABLE_NAMES } from './outreach-sequence.js';
// Drafting a step is the ONE place this module reasons, and it does so only
// through the sanctioned llm gateway.
import { callGateway } from '../gateways/index.js';
import { loadModelConfig } from './model-config.js';

const CHUNK = 80;
const LIVE_FLAG = 'outreach.live';
// Members predating named cohorts, and anything created without one, live here.
const DEFAULT_COHORT = 'oq_default';

const qid = () => `oq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ── named cohorts ──────────────────────────────────────────────────────────
// A cohort owns three things: who is in it, the copy they all receive, and its
// own run state + sending window. Status gates the sender, so pausing one stops
// every message inside it without disturbing anyone's place in the sequence.
export async function listCohorts(env) {
  const rows = ((await env.DB.prepare(
    'SELECT * FROM outreach_cohorts ORDER BY created_at ASC',
  ).all().catch(() => ({ results: [] }))).results) || [];
  const counts = ((await env.DB.prepare(
    `SELECT COALESCE(cohort_id, ?) AS cohort_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN answered_at IS NOT NULL THEN 1 ELSE 0 END) AS answered
       FROM outreach_cohort_members GROUP BY COALESCE(cohort_id, ?)`,
  ).bind(DEFAULT_COHORT, DEFAULT_COHORT).all().catch(() => ({ results: [] }))).results) || [];
  const byId = new Map(counts.map((c) => [c.cohort_id, c]));
  return {
    cohorts: rows.map((r) => ({
      id: r.id, name: r.name, note: r.note || null, created_at: r.created_at,
      status: r.status || 'active',
      timezone: r.timezone || null,
      start_hour: r.start_hour ?? null,
      end_hour: r.end_hour ?? null,
      send_days: (() => { try { return r.send_days ? JSON.parse(r.send_days) : null; } catch { return null; } })(),
      // Per-weekday eligible sending times, {weekday: {start,end}}. NULL means
      // the cohort inherits the account default window.
      send_windows: (() => { const w = parseWindows(r.send_windows); return w ? Object.fromEntries(Object.entries(w).map(([d, x]) => [d, { start: x.start, end: x.end }])) : null; })(),
      languages: (() => { try { return r.languages ? JSON.parse(r.languages) : null; } catch { return null; } })(),
      has_sequence: !!String(r.sequence || '').trim() && parseSequence(r.sequence).steps.length > 0,
      total: byId.get(r.id)?.total || 0,
      active: byId.get(r.id)?.active || 0,
      answered: byId.get(r.id)?.answered || 0,
    })),
  };
}

export async function createCohort(env, { name, note = null } = {}) {
  const clean = String(name || '').trim();
  if (!clean) return { error: 'a cohort name is required' };
  if (clean.length > 80) return { error: 'cohort name is too long (80 characters max)' };
  const existing = await env.DB.prepare('SELECT * FROM outreach_cohorts WHERE name = ?').bind(clean).first().catch(() => null);
  // Idempotent by name: re-creating an existing cohort hands back that one
  // rather than failing the caller or minting a confusing duplicate.
  if (existing) return { cohort: { id: existing.id, name: existing.name }, created: false };
  const id = qid();
  const t = now();
  await env.DB.prepare(
    'INSERT INTO outreach_cohorts (id, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, clean, note || null, t, t).run();
  await logEvent(env, { kind: 'outreach_cohort_created', payload: { id, name: clean } });
  return { cohort: { id, name: clean }, created: true };
}

// A cohort's run state and its own sending window. Status is not decoration:
// the sender skips any cohort that is not `active`, so pausing or cancelling
// one stops every scheduled message inside it at once without touching the
// people or their position in the sequence.
export const COHORT_STATUSES = ['active', 'paused', 'finished', 'canceled'];

export async function updateCohort(env, patch = {}) {
  const { cohort_id } = patch;
  if (!cohort_id) return { error: 'cohort_id required' };
  const row = await env.DB.prepare('SELECT * FROM outreach_cohorts WHERE id = ?').bind(cohort_id).first().catch(() => null);
  if (!row) return { error: 'no such cohort' };

  const set = {};
  if (patch.name !== undefined) {
    const clean = String(patch.name || '').trim();
    if (!clean) return { error: 'a cohort name is required' };
    set.name = clean;
  }
  if (patch.status !== undefined) {
    if (!COHORT_STATUSES.includes(patch.status)) return { error: `status must be one of ${COHORT_STATUSES.join(', ')}` };
    set.status = patch.status;
  }
  if (patch.timezone !== undefined) {
    const tz = String(patch.timezone || '').trim();
    // A zone the runtime cannot resolve would silently push every send to a
    // wrong hour, so refuse it here rather than at 3am in someone's morning.
    if (tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return { error: `unknown timezone "${tz}"` }; } }
    set.timezone = tz || null;
  }
  if (patch.send_days !== undefined) {
    const days = Array.isArray(patch.send_days)
      ? [...new Set(patch.send_days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [];
    // An empty list means "never" — store NULL (inherit) instead of freezing
    // the cohort in a state whose only symptom is nothing ever sending.
    set.send_days = days.length ? JSON.stringify(days) : null;
  }
  if (patch.languages !== undefined) {
    const langs = Array.isArray(patch.languages)
      ? [...new Set(patch.languages.map((l) => String(l || '').trim().toLowerCase()).filter(Boolean))]
      : [];
    set.languages = langs.length ? JSON.stringify(langs) : null;
  }
  if (patch.send_windows !== undefined) {
    // Validate through the same parser the engine reads with, so anything the
    // engine would silently ignore is refused here where it can be seen. An
    // empty result stores NULL = inherit, rather than a cohort that looks
    // configured and never sends.
    const win = parseWindows(patch.send_windows);
    if (patch.send_windows && !win && Object.keys(patch.send_windows || {}).length) {
      return { error: 'sending times must be HH:MM with the end after the start' };
    }
    set.send_windows = win
      ? JSON.stringify(Object.fromEntries(Object.entries(win).map(([d, w]) => [d, { start: w.start, end: w.end }])))
      : null;
  }
  if (patch.start_hour !== undefined || patch.end_hour !== undefined) {
    const s = patch.start_hour === undefined ? row.start_hour : Number(patch.start_hour);
    const e = patch.end_hour === undefined ? row.end_hour : Number(patch.end_hour);
    if (s != null && e != null) {
      if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e > 24 || e <= s) {
        return { error: 'sending hours must be 0–24 with the end after the start' };
      }
      set.start_hour = Math.floor(s);
      set.end_hour = Math.floor(e);
    }
  }
  if (!Object.keys(set).length) return { error: 'nothing to change' };

  const keys = Object.keys(set);
  await env.DB.prepare(
    `UPDATE outreach_cohorts SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`,
  ).bind(...keys.map((k) => set[k]), now(), cohort_id).run();
  await logEvent(env, { kind: 'outreach_cohort_updated', actor: 'operator', payload: { cohort_id, ...set } });
  return { ok: true, cohort_id, ...set };
}

export async function deleteCohort(env, { cohort_id } = {}) {
  if (!cohort_id) return { error: 'cohort_id required' };
  if (cohort_id === DEFAULT_COHORT) return { error: 'the default cohort cannot be deleted' };
  const n = Number((await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM outreach_cohort_members WHERE cohort_id = ?',
  ).bind(cohort_id).first().catch(() => null))?.n || 0);
  if (n) return { error: `${n} prospect${n === 1 ? ' is' : 's are'} still in this cohort — remove them first` };
  await env.DB.prepare('DELETE FROM outreach_cohorts WHERE id = ?').bind(cohort_id).run().catch(() => {});
  await logEvent(env, { kind: 'outreach_cohort_deleted', payload: { cohort_id } });
  return { deleted: true, cohort_id };
}

async function cohortName(env, id) {
  if (!id) return null;
  const r = await env.DB.prepare('SELECT name FROM outreach_cohorts WHERE id = ?').bind(id).first().catch(() => null);
  return r?.name || null;
}

// Real sending requires an explicit opt-in. Absent/false => dry run.
async function isLive(env) {
  // LIVE by default: an approved, scheduled message is an instruction to send.
  // The flag stays as an explicit pause (set outreach.live false to hold the
  // queue). Per-message approval, pacing and the no-duplicate claim are what
  // actually prevent a mistake, and they are untouched.
  try { return (await flagsAsObject(env))[LIVE_FLAG] !== false; } catch { return false; }
}

const chatIdOf = (lead) => {
  const digits = String(lead?.normalized_phone || lead?.phone || '').replace(/\D/g, '');
  return digits ? `${digits}@c.us` : null;
};

// The cohort's own message sequence, and what it renders to for one prospect.
// The COHORT owns the copy now — a prospect needs no angle of their own to be
// approachable, which is what previously made most of a qualified list unusable.
export async function cohortRow(env, cohortId) {
  return env.DB.prepare('SELECT * FROM outreach_cohorts WHERE id = ?')
    .bind(cohortId || DEFAULT_COHORT).first().catch(() => null);
}

async function sequenceOf(env, cohortId) {
  const r = await env.DB.prepare('SELECT sequence FROM outreach_cohorts WHERE id = ?')
    .bind(cohortId || DEFAULT_COHORT).first().catch(() => null);
  return parseSequence(r?.sequence);
}

// `scope` decides what a bulk edit does to the people ALREADY in the cohort:
//
//   'new_only' (default) — anyone who was hand-edited keeps their own message.
//                          The edit reaches everybody else, and everybody added
//                          from now on.
//   'everyone'           — the cohort's copy replaces the hand-written ones too.
//
// APPROVALS ARE WITHDRAWN EITHER WAY, for every member whose next message this
// changes. Approval means "I have read this text"; leaving one standing after
// the text underneath it changed would send words nobody signed off — which is
// the entire thing the approval gate exists to prevent. So the scope choice is
// about whose WORDS survive, never about whether the gate is re-armed.
export const SEQUENCE_SCOPES = ['new_only', 'everyone'];

export async function saveSequence(env, { cohort_id, sequence, scope = 'new_only' } = {}) {
  if (!cohort_id) return { error: 'cohort_id required' };
  if (!SEQUENCE_SCOPES.includes(scope)) return { error: `scope must be one of ${SEQUENCE_SCOPES.join(', ')}` };
  const exists = await env.DB.prepare('SELECT 1 FROM outreach_cohorts WHERE id = ?').bind(cohort_id).first().catch(() => null);
  if (!exists) return { error: 'no such cohort' };
  const check = validateSequence(sequence);
  if (check.unknown_variables.length) {
    return { error: `unknown variable${check.unknown_variables.length > 1 ? 's' : ''}: ${check.unknown_variables.map((v) => `{${v}}`).join(', ')}` };
  }
  const t = now();
  await env.DB.prepare('UPDATE outreach_cohorts SET sequence = ?, updated_at = ? WHERE id = ?')
    .bind(serializeSequence(sequence), t, cohort_id).run();

  // Whose hand-written message just got overwritten — counted BEFORE the write,
  // so the caller can tell the operator what it cost rather than guessing.
  const editedCount = Number((await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM outreach_cohort_members
      WHERE COALESCE(cohort_id, ?) = ? AND override_text IS NOT NULL`,
  ).bind(DEFAULT_COHORT, cohort_id).first().catch(() => null))?.n || 0);

  let replaced = 0;
  if (scope === 'everyone' && editedCount) {
    await env.DB.prepare(
      `UPDATE outreach_cohort_members
          SET override_text = NULL, override_step = NULL, updated_at = ?
        WHERE COALESCE(cohort_id, ?) = ? AND override_text IS NOT NULL`,
    ).bind(t, DEFAULT_COHORT, cohort_id).run();
    replaced = editedCount;
  }

  // Re-arm the gate. On 'new_only' the hand-edited members keep their approval,
  // because the text THEY are getting has not changed — theirs is the override,
  // which this write did not touch.
  const keepEdited = scope === 'new_only' ? ' AND override_text IS NULL' : '';
  const unapproved = Number((await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM outreach_cohort_members
      WHERE COALESCE(cohort_id, ?) = ? AND approved_step IS NOT NULL${keepEdited}`,
  ).bind(DEFAULT_COHORT, cohort_id).first().catch(() => null))?.n || 0);
  await env.DB.prepare(
    `UPDATE outreach_cohort_members
        SET approved_step = NULL, approved_step_at = NULL, updated_at = ?
      WHERE COALESCE(cohort_id, ?) = ? AND approved_step IS NOT NULL${keepEdited}`,
  ).bind(t, DEFAULT_COHORT, cohort_id).run();

  await logEvent(env, {
    kind: 'outreach_sequence_saved', actor: 'operator',
    payload: { cohort_id, scope, edits_replaced: replaced, approvals_withdrawn: unapproved, ...check },
  });
  return { ok: true, cohort_id, scope, edits_replaced: replaced, approvals_withdrawn: unapproved, edits_kept: scope === 'new_only' ? editedCount : 0, ...check };
}

// ── draft one step's copy ───────────────────────────────────────────────────
// The editor's "generate" button. Writes ONE step for the cohort, using who is
// actually in it as the brief, and hands the text back for the operator to read
// and edit. It never saves and never sends — the copy only becomes real when
// they press save, which is what keeps "every automated message was approved"
// true even when a model helped write it.
export async function generateStepCopy(env, { cohort_id, step_index = 0, language = 'en', instruction = '' } = {}) {
  if (!cohort_id) return { error: 'cohort_id required' };
  const coh = await cohortRow(env, cohort_id);
  if (!coh) return { error: 'no such cohort' };

  // The brief is the cohort itself: its name, and a sample of who is in it.
  const sample = ((await env.DB.prepare(
    `SELECT l.name, l.company, l.position, l.country
       FROM outreach_cohort_members m JOIN gtm_leads l ON l.id = m.lead_id
      WHERE COALESCE(m.cohort_id, ?) = ? LIMIT 8`,
  ).bind(DEFAULT_COHORT, cohort_id).all().catch(() => ({ results: [] }))).results) || [];

  const seq = await sequenceOf(env, cohort_id);
  const earlier = seq.steps.slice(0, step_index)
    .map((s, i) => `${i + 1}. ${Object.values(s.bodies)[0] || ''}`).filter(Boolean).join('\n');

  const { rules } = await import('./outreach-wa.js').then((m) => m.loadDraftingRules(env));
  const model = (await loadModelConfig(env)).writer;

  const system = `You write one outreach message for a COHORT — a group of prospects who share a reason to be approached. The same text goes to everyone in the group, personalised only by variables.

Use ONLY these variables, in curly braces, and only where they genuinely help: ${VARIABLE_NAMES.map((v) => `{${v}}`).join(' ')}. Never invent a variable. Never write a name or company literally — use the variable.

${rules}

Return ONLY the message text. No preamble, no quotes, no alternatives.`;

  const who = sample.length
    ? sample.map((p) => `- ${[p.position, p.company, p.country].filter(Boolean).join(', ')}`).join('\n')
    : '(nobody added yet — write for the cohort name alone)';
  const prompt = [
    `COHORT: ${coh.name}`,
    `WHO IS IN IT:\n${who}`,
    earlier ? `MESSAGES ALREADY IN THE SEQUENCE (do not repeat them):\n${earlier}` : '',
    step_index === 0
      ? 'Write the FIRST message — a cold opener to someone who has never heard from us.'
      : `Write message ${step_index + 1} — a follow-up to someone who has NOT replied to the earlier ones. Do not thank them for a reply, and do not imply they responded.`,
    language !== 'en' ? `Write it in ${language === 'he' ? 'Hebrew' : language}.` : '',
    instruction ? `EXTRA DIRECTION FROM THE OPERATOR: ${instruction}` : '',
  ].filter(Boolean).join('\n\n');

  let text;
  try {
    text = await callGateway(env, 'llm', 'text', { system, prompt, model, max_tokens: 400, heavy: false });
  } catch (e) {
    return { error: `could not draft it (${String(e?.message || e)})` };
  }
  const draft = String(text || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!draft) return { error: 'the model returned nothing' };

  await logEvent(env, {
    kind: 'outreach_step_drafted', actor: 'operator',
    payload: { cohort_id, step_index, language, chars: draft.length },
  });
  return { draft, cohort_id, step_index, language, based_on: sample.length };
}

export async function readSequence(env, { cohort_id } = {}) {
  const seq = await sequenceOf(env, cohort_id);
  return { cohort_id: cohort_id || DEFAULT_COHORT, sequence: seq, ...validateSequence(seq) };
}

// Gap before the step at `index`. Step 0 goes as soon as it is approved; the
// spacing of later steps is the cohort's, authored alongside the copy.
function delayForStep(seq, index) {
  const s = seq.steps[index];
  return Math.max(0, Number(s?.delay_hours || 0)) * 3600000;
}

async function readRow(env, leadId) {
  return env.DB.prepare('SELECT * FROM outreach_cohort_members WHERE lead_id = ?').bind(leadId).first().catch(() => null);
}

async function writeRow(env, leadId, patch) {
  const fields = { ...patch, updated_at: now() };
  const keys = Object.keys(fields);
  await env.DB.prepare(
    `UPDATE outreach_cohort_members SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE lead_id=?`,
  ).bind(...keys.map((k) => fields[k]), leadId).run().catch(() => {});
}

// ── enrol ───────────────────────────────────────────────────────────────────
// Put a prospect on the cohort. Idempotent: re-enrolling someone already on it
// returns the existing row rather than restarting their ladder. A prospect who
// has already replied is refused — the cohort is for people we still need to
// reach, not people we are mid-conversation with.
export async function enroll(env, { lead_id, cohort_id = null, override = false, start_at = null } = {}) {
  if (!lead_id) return { error: 'lead_id required' };
  const lead = await getLead(env, lead_id).catch(() => null);
  if (!lead) return { error: 'no such lead' };
  const target = cohort_id || DEFAULT_COHORT;

  const existing = await readRow(env, lead_id);
  if (existing) {
    const current = existing.cohort_id || DEFAULT_COHORT;
    if (current === target) return { added: false, reason: 'already in this cohort', lead_id, cohort_id: current };
    // ── THE ANTI-SPAM RULE ── they are already being worked in another cohort.
    // Refuse and hand the decision to a human rather than quietly messaging the
    // same person from two campaigns.
    if (!override) {
      return {
        conflict: true, lead_id, name: lead.name || null,
        current_cohort: { id: current, name: await cohortName(env, current) },
        requested_cohort: { id: target, name: await cohortName(env, target) },
        message: `${lead.name || 'This prospect'} is already in "${await cohortName(env, current) || current}". Adding them here would mean two campaigns messaging the same person.`,
      };
    }
    // Overridden: MOVE them. Never a second row — the primary key would not
    // allow one anyway, and duplicating is exactly what we are preventing.
    await writeRow(env, lead_id, { cohort_id: target });
    await logEvent(env, {
      kind: 'outreach_cohort_override',
      actor: 'operator',
      payload: { lead_id, name: lead.name || null, from: current, to: target },
    });
    return { added: true, moved: true, lead_id, cohort_id: target, from_cohort: current };
  }

  const chatId = chatIdOf(lead);
  if (!chatId) return { error: 'lead has no usable phone number' };

  const facts = await threadFacts(env, { chat_id: chatId, lead, limit: 50 });
  if (facts.answered) {
    return { error: 'this prospect has already replied — they belong in Conversations, not the cohort' };
  }

  // STAGED, not scheduled. Adding somebody to a cohort is a filing decision;
  // it must never be the thing that causes a message. The sender only ever
  // selects status='active', so a staged row is invisible to it by
  // construction rather than by a check that could regress.
  const t = now();
  await env.DB.prepare(
    `INSERT INTO outreach_cohort_members (lead_id, chat_id, cohort_id, status, step, next_send_at, last_sent_at, enrolled_at, updated_at)
     VALUES (?, ?, ?, 'staged', 0, NULL, ?, ?, ?)`,
  ).bind(lead_id, chatId, target, facts.last_out_at ?? null, t, t).run();

  await logEvent(env, {
    kind: 'outreach_cohort_staged',
    payload: { lead_id, name: lead.name || null, cohort_id: target },
  });
  return { added: true, staged: true, lead_id, cohort_id: target };
}

// ── go live ─────────────────────────────────────────────────────────────────
// The ONLY thing that turns staged people into scheduled ones. Explicit, per
// selection, and it refuses anyone whose messages would render with a hole in
// them — a blank {company} reaching a prospect is worse than no message.
export async function goLive(env, { lead_ids = [], start_at = null } = {}) {
  const ids = [...new Set((lead_ids || []).filter(Boolean))];
  if (!ids.length) return { error: 'nobody selected' };
  const { cadence } = await loadCohortCadence(env);
  const seqCache = new Map();
  const cohortCache = new Map();

  const live = [];
  const blocked = [];
  for (const id of ids) {
    const row = await readRow(env, id);
    if (!row) { blocked.push({ lead_id: id, reason: 'not on any cohort' }); continue; }
    if (row.answered_at) { blocked.push({ lead_id: id, reason: 'they have replied — automation is off for them' }); continue; }
    if (row.status === 'active') { blocked.push({ lead_id: id, reason: 'already live' }); continue; }

    const lead = await getLead(env, row.lead_id).catch(() => null);
    if (!lead) { blocked.push({ lead_id: id, reason: 'lead missing' }); continue; }

    const qId = row.cohort_id || DEFAULT_COHORT;
    if (!seqCache.has(qId)) seqCache.set(qId, await sequenceOf(env, qId));
    if (!cohortCache.has(qId)) cohortCache.set(qId, await cohortRow(env, qId));
    const seq = seqCache.get(qId);
    const coh = cohortCache.get(qId);
    // Scheduling uses the COHORT's window, so "9am" means 9am wherever this
    // group actually lives rather than wherever the account default points.
    const cad = effectiveCadence(cadence, coh);

    // The whole sequence must render for THIS person before any of it is
    // scheduled — catching it now, not three steps in.
    const rendered = renderSequence(seq, lead);
    if (rendered.blocked) {
      blocked.push({ lead_id: id, name: lead.name || null, reason: rendered.blocked });
      continue;
    }

    const base = start_at || now();
    await writeRow(env, id, {
      status: 'active',
      step: 0,
      approved_at: now(),
      next_send_at: nextWindowOpening(base + delayForStep(seq, 0), cad),
      stop_reason: null,
      last_error: null,
    });
    live.push({ lead_id: id, name: lead.name || null, steps: rendered.length, first_text: rendered.steps[0]?.text || null });
  }

  await logEvent(env, {
    kind: 'outreach_cohort_go_live',
    actor: 'operator',
    payload: { requested: ids.length, live: live.length, blocked: blocked.length },
  });
  return { live, blocked, requested: ids.length };
}

// ── bulk add (the Prospecting CTA) ──────────────────────────────────────────
// Adds many prospects to one cohort and reports each outcome separately, because
// a batch will normally be a mix: some enrol, some have no approved angle yet,
// and some are already being worked in another cohort. The conflicts come back
// as their own list so the operator can approve the override for exactly those
// people — never a blanket "force everything".
export async function enrollMany(env, { lead_ids = [], cohort_id = null, override = false } = {}) {
  const ids = [...new Set((lead_ids || []).filter(Boolean))];
  if (!ids.length) return { error: 'no prospects selected' };
  if (ids.length > 200) return { error: 'too many at once — select 200 or fewer' };
  const target = cohort_id || DEFAULT_COHORT;

  const added = [];
  const conflicts = [];
  const skipped = [];
  for (const id of ids) {
    let r;
    try { r = await enroll(env, { lead_id: id, cohort_id: target, override }); }
    catch (e) { r = { error: String(e?.message || e) }; }
    if (r?.conflict) conflicts.push(r);
    else if (r?.added) added.push(r);
    else skipped.push({ lead_id: id, reason: r?.error || r?.reason || 'not enrolled' });
  }

  await logEvent(env, {
    kind: 'outreach_cohort_bulk_added',
    payload: { cohort_id: target, requested: ids.length, added: added.length, conflicts: conflicts.length, skipped: skipped.length, override: !!override },
  });
  return {
    cohort_id: target, cohort_name: await cohortName(env, target),
    requested: ids.length, added, conflicts, skipped,
  };
}

export async function remove(env, { lead_id, reason = 'manual' } = {}) {
  if (!lead_id) return { error: 'lead_id required' };
  await env.DB.prepare('DELETE FROM outreach_cohort_members WHERE lead_id = ?').bind(lead_id).run().catch(() => {});
  await logEvent(env, { kind: 'outreach_cohort_removed', payload: { lead_id, reason } });
  return { removed: true, lead_id };
}

// pause / resume / stop a single enrolment. Stopping is terminal-but-visible;
// removing is what clears the row entirely.
export async function control(env, { lead_id, action } = {}) {
  if (!lead_id || !action) return { error: 'lead_id and action required' };
  const row = await readRow(env, lead_id);
  if (!row) return { error: 'not enrolled' };
  if (row.answered_at && action === 'resume') {
    return { error: 'this prospect replied — automation cannot be resumed for them' };
  }
  const { cadence } = await loadCohortCadence(env);
  const patch = action === 'pause' ? { status: 'paused' }
    : action === 'resume' ? { status: 'active', next_send_at: nextWindowOpening(now(), cadence) }
    : action === 'stop' ? { status: 'stopped', stop_reason: 'manual', next_send_at: null }
    // Back to a draft: they keep their place in the ladder and their approval,
    // they simply have no send time any more. The tick only ever selects rows
    // WITH one, so this takes them out of the run without stopping them.
    : action === 'unschedule' ? { status: 'staged', next_send_at: null, stop_reason: null }
    : null;
  if (!patch) return { error: `unknown action "${action}"` };
  await writeRow(env, lead_id, patch);
  await logEvent(env, { kind: 'outreach_cohort_control', payload: { lead_id, action } });
  return { lead_id, ...patch };
}

// ── read the cohort ──────────────────────────────────────────────────────────
// One row per enrolled prospect with what actually matters: what we last said,
// what goes next and when, and whether they have answered (in which case the
// automation is already off).
// ── moving ONE person's next send ───────────────────────────────────────────
// The sheet's Sending cell, edited in place. Stores EXACTLY the moment picked —
// it is not snapped into the cohort's window, because silently moving an
// operator's chosen time is worse than letting it wait: the tick only runs
// inside the window anyway, so a time outside it simply means "first chance
// after that". `outside_window` is returned so the UI can say so out loud.
//
// Setting a time on someone staged is a go-live, and carries go-live's guard:
// the whole sequence must render for this person before any of it is armed.
export async function rescheduleMember(env, { lead_id, send_at } = {}) {
  const leadId = String(lead_id || '').trim();
  if (!leadId) return { error: 'lead_id required' };
  const at = Number(send_at);
  if (!Number.isFinite(at) || at <= 0) return { error: 'a send time is required' };

  const row = await readRow(env, leadId);
  if (!row) return { error: 'not in a cohort' };
  if (row.answered_at) return { error: 'they replied — automation is off them' };
  if (row.status === 'stopped' || row.status === 'done') {
    return { error: `this prospect is ${row.status} — resume them before scheduling` };
  }

  const lead = await getLead(env, leadId).catch(() => null);
  if (!lead) return { error: 'lead missing' };
  const qId = row.cohort_id || DEFAULT_COHORT;
  const rendered = renderSequence(await sequenceOf(env, qId), lead);
  if (rendered.blocked) return { error: rendered.blocked };

  const { cadence } = await loadCohortCadence(env);
  const coh = await cohortRow(env, qId);
  const cad = effectiveCadence(cadence, coh);
  const tz = coh?.timezone || cadence.timezone;

  // A time that has already passed is not an error — it means "as soon as the
  // sender next runs", which is a thing operators legitimately want.
  await writeRow(env, leadId, {
    status: 'active',
    next_send_at: at,
    stop_reason: null,
    // Rescheduling is not re-approving. If the operator had approved this
    // message, moving WHEN it goes does not change WHAT goes, so the approval
    // stands; the text is untouched.
  });
  await logEvent(env, {
    kind: 'outreach_member_rescheduled', actor: 'operator',
    payload: { lead_id: leadId, send_at: at, was: row.next_send_at || null, from_staged: row.status === 'staged' },
  });
  return {
    lead_id: leadId,
    next_send_at: at,
    went_live: row.status === 'staged',
    outside_window: !withinWindow(at, cad),
    ...zonedLabel(at, tz),
  };
}

// ── approving one message for one person ────────────────────────────────────
// Approval is stored as the STEP INDEX approved, never as a boolean. Sending
// advances `step`, so the stored index stops matching by itself and the next
// message is un-approved by construction — nothing has to remember to clear it.
//
// Approving does not schedule and does not send. A staged person still needs
// go-live to get a send time; this only says "this particular message is fit to
// leave". The two gates are separate on purpose: one is about the person, the
// other about the words.
export async function approveMessages(env, { lead_ids = [], approve = true } = {}) {
  const ids = [...new Set((lead_ids || []).map((s) => String(s || '').trim()).filter(Boolean))];
  if (!ids.length) return { error: 'select at least one prospect' };

  const approved = [];
  const refused = [];
  const t = now();

  // Withdrawing needs none of the checks below — it can only ever make the
  // system quieter, so it is safe to do first and in bulk.
  if (!approve) {
    for (const leadId of ids) {
      const r = await env.DB.prepare(
        'UPDATE outreach_cohort_members SET approved_step = NULL, approved_step_at = NULL, updated_at = ? WHERE lead_id = ?',
      ).bind(t, leadId).run().catch(() => null);
      if (r) approved.push({ lead_id: leadId, approved: false });
    }
    await logEvent(env, { kind: 'outreach_message_unapproved', actor: 'operator', payload: { count: approved.length, lead_ids: ids } });
    return { approved, refused };
  }

  const rows = new Map();
  const leadsById = new Map();
  for (const leadId of ids) {
    const row = await env.DB.prepare('SELECT * FROM outreach_cohort_members WHERE lead_id = ?').bind(leadId).first().catch(() => null);
    if (!row) { refused.push({ lead_id: leadId, reason: 'not in a cohort' }); continue; }
    const lead = await getLead(env, leadId).catch(() => null);
    if (!lead) { refused.push({ lead_id: leadId, reason: 'lead missing' }); continue; }
    rows.set(leadId, row);
    leadsById.set(leadId, lead);
  }

  // ── read the CONVERSATION, not the stored flag ──
  // `answered_at` is only written when the tick next runs, so a prospect who
  // replied five minutes ago still has it NULL. Trusting it would let the
  // operator approve a message for somebody already mid-conversation — the one
  // thing this module must never do. Same rule the sender applies before every
  // send, applied here for the same reason, in one bulk read.
  const convo = await conversationStatesFor(env, [...rows.values()].map((row) => ({
    id: row.lead_id,
    chat_id: row.chat_id,
    normalized_phone: leadsById.get(row.lead_id)?.normalized_phone || null,
    phone: leadsById.get(row.lead_id)?.phone || null,
  }))).catch(() => new Map());

  for (const leadId of [...rows.keys()]) {
    const row = rows.get(leadId);
    const lead = leadsById.get(leadId);
    if (row.answered_at || convo.get(leadId)?.answered) {
      refused.push({ lead_id: leadId, name: lead.name || null, reason: 'they replied — automation is off them' });
      continue;
    }

    // Approve exactly the message the sheet showed. For a staged person that is
    // the opener; for a live one it is whatever step they are on.
    // NOT `staged ? 0` — an unscheduled member keeps their place in the ladder.
    const step = row.step;

    // Re-render before approving rather than trusting the row the browser was
    // looking at: the cohort's copy or the prospect's fields may have changed
    // since it loaded, and approving a message with a hole in it is exactly the
    // failure this gate exists to prevent.
    const rendered = renderSequence(await sequenceOf(env, row.cohort_id), lead);
    if (rendered.blocked) { refused.push({ lead_id: leadId, name: lead.name || null, reason: rendered.blocked }); continue; }
    if (!rendered.steps[step]) { refused.push({ lead_id: leadId, name: lead.name || null, reason: 'no message at this step' }); continue; }
    if (row.override_text && row.override_step === step) {
      const o = renderBody(row.override_text, lead);
      if (o.missing.length || o.unknown.length) {
        refused.push({ lead_id: leadId, name: lead.name || null, reason: `edited message has unfilled ${[...o.missing, ...o.unknown].join(', ')}` });
        continue;
      }
    }

    await env.DB.prepare(
      'UPDATE outreach_cohort_members SET approved_step = ?, approved_step_at = ?, updated_at = ? WHERE lead_id = ?',
    ).bind(step, t, t, leadId).run();
    approved.push({ lead_id: leadId, name: lead.name || null, step, approved: true });
  }

  await logEvent(env, {
    kind: approve ? 'outreach_message_approved' : 'outreach_message_unapproved',
    // An approval trail whose actor reads 'system' is not an approval trail.
    actor: 'operator',
    payload: { count: approved.length, refused: refused.length, lead_ids: approved.map((a) => a.lead_id) },
  });
  return { approved, refused };
}

// ── editing one message for one person ──────────────────────────────────────
// The edit belongs to this prospect at this step, NOT to the cohort: the group's
// authored copy is never touched by it. Saving an edit CLEARS any approval —
// approval means "I have read this text", and the text just changed.
export async function saveMessageOverride(env, { lead_id, text, clear = false } = {}) {
  const leadId = String(lead_id || '').trim();
  if (!leadId) return { error: 'lead_id required' };
  const row = await env.DB.prepare('SELECT * FROM outreach_cohort_members WHERE lead_id = ?').bind(leadId).first().catch(() => null);
  if (!row) return { error: 'not in a cohort' };
  // NOT `staged ? 0` — an unscheduled member keeps their place in the ladder.
  const step = row.step;
  const t = now();

  if (clear || !String(text || '').trim()) {
    await env.DB.prepare(
      `UPDATE outreach_cohort_members
          SET override_text = NULL, override_step = NULL,
              approved_step = NULL, approved_step_at = NULL, updated_at = ?
        WHERE lead_id = ?`,
    ).bind(t, leadId).run();
    await logEvent(env, { kind: 'outreach_message_edit_cleared', actor: 'operator', payload: { lead_id: leadId, step } });
    return { lead_id: leadId, step, cleared: true };
  }

  const body = String(text).trim();
  const { cadence } = await loadCohortCadence(env);
  if (body.length > cadence.max_message_chars) {
    return { error: `message is too long (${cadence.max_message_chars} characters max)` };
  }
  const lead = await getLead(env, leadId).catch(() => null);
  if (!lead) return { error: 'lead missing' };
  // Refuse a broken edit at the point of saving, where the operator is looking
  // at it, rather than accepting it and failing silently at send time.
  const r = renderBody(body, lead);
  if (r.unknown.length) return { error: `unknown variable${r.unknown.length > 1 ? 's' : ''}: ${r.unknown.map((u) => `{${u}}`).join(', ')}` };
  if (r.missing.length) return { error: `this prospect has no ${r.missing.map((m) => m.replace(/_/g, ' ')).join(', ')}` };

  await env.DB.prepare(
    `UPDATE outreach_cohort_members
        SET override_text = ?, override_step = ?,
            approved_step = NULL, approved_step_at = NULL, updated_at = ?
      WHERE lead_id = ?`,
  ).bind(body, step, t, leadId).run();
  await logEvent(env, { kind: 'outreach_message_edited', actor: 'operator', payload: { lead_id: leadId, step, chars: body.length } });
  return { lead_id: leadId, step, text: r.text, approved_cleared: true };
}

export async function listCohortMembers(env, { status = null, cohort_id = null } = {}) {
  const where = [];
  const binds = [];
  if (status && status !== 'all') { where.push('status = ?'); binds.push(status); }
  if (cohort_id && cohort_id !== 'all') { where.push('COALESCE(cohort_id, ?) = ?'); binds.push(DEFAULT_COHORT, cohort_id); }
  const rows = ((await env.DB.prepare(
    `SELECT * FROM outreach_cohort_members ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (next_send_at IS NULL), next_send_at ASC`,
  ).bind(...binds).all().catch(() => ({ results: [] }))).results) || [];
  const { cohorts } = await listCohorts(env);
  const nameOf = new Map(cohorts.map((qq) => [qq.id, qq.name]));
  if (!rows.length) {
    return { members: [], cohorts, counts: { active: 0, answered: 0, paused: 0, done: 0, stopped: 0 }, live: await isLive(env) };
  }

  // Lead details in one chunked read rather than one query per row.
  const leadIds = rows.map((r) => r.lead_id);
  const leads = new Map();
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const c = leadIds.slice(i, i + CHUNK);
    // country + outreach_lang are NOT optional here: they decide which language
    // variant a prospect gets, so omitting them silently previewed every
    // Israeli lead in English while the sender would have used Hebrew.
    const r = (await env.DB.prepare(
      `SELECT id, name, company, position, photo, icp_fit, normalized_phone, phone, country, outreach_lang
         FROM gtm_leads WHERE id IN (${c.map(() => '?').join(',')})`,
    ).bind(...c).all().catch(() => ({ results: [] }))).results || [];
    for (const l of r) leads.set(l.id, l);
  }

  // Where each prospect's actual WhatsApp conversation stands, for every member
  // in one chunked pass. Same derivation the Conversations tab uses, so a person
  // cannot read "active" there and "untouched" here.
  const convo = await conversationStatesFor(
    env,
    rows.map((r) => ({
      id: r.lead_id,
      chat_id: r.chat_id,
      normalized_phone: leads.get(r.lead_id)?.normalized_phone || null,
      phone: leads.get(r.lead_id)?.phone || null,
    })),
  ).catch(() => new Map());

  const { cadence } = await loadCohortCadence(env);
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));

  const seqCache = new Map();
  const members = [];
  for (const row of rows) {
    const lead = leads.get(row.lead_id) || null;
    const qId = row.cohort_id || DEFAULT_COHORT;
    if (!seqCache.has(qId)) seqCache.set(qId, await sequenceOf(env, qId));
    // Rendered for THIS person, so the row shows the message they would
    // actually receive — variables filled, in their language — not a template.
    const rendered = lead ? renderSequence(seqCache.get(qId), lead) : { steps: [], length: 0, blocked: 'lead missing' };
    const ladder = rendered.steps.map((s) => s.text);
    // Which step's copy this row is about. Staged people have not started, so
    // the message on offer is the opener.
    const shownStep = row.step;
    // A per-person edit replaces the cohort's copy for THAT step only, and is
    // rendered through the same substitution so it cannot ship a raw {token}.
    const override = (row.override_text && row.override_step === shownStep && lead)
      ? renderBody(row.override_text, lead)
      : null;
    // Both a live and a staged member are 'about to get' their current step;
    // only a paused/stopped/finished one has nothing pending.
    const baseText = (row.status === 'active' || row.status === 'staged')
      ? (ladder[row.step] ?? null)
      : null;
    const nextText = baseText === null ? null : (override ? override.text : baseText);

    // The zone the send is actually measured in — the cohort's own if it has
    // one, else the account default. Named on the server so the browser never
    // re-derives it.
    const tz = cohortById.get(qId)?.timezone || cadence.timezone;
    const when = row.status === 'active' && row.next_send_at ? zonedLabel(row.next_send_at, tz) : null;

    // Approval is per (person, step): the stored step must equal the step about
    // to go out. After a send moves them forward the match breaks by itself, so
    // the next message is un-approved without anything having to clear a flag.
    const approved = row.approved_step != null && row.approved_step === shownStep;

    members.push({
      lead_id: row.lead_id,
      chat_id: row.chat_id,
      cohort_id: row.cohort_id || DEFAULT_COHORT,
      cohort_name: nameOf.get(row.cohort_id || DEFAULT_COHORT) || null,
      name: lead?.name || null,
      company: lead?.company || null,
      position: lead?.position || null,
      photo: lead?.photo || null,
      icp_fit: lead?.icp_fit || null,
      status: row.status,
      // Staged = filed into the cohort but NOT scheduled. Only go-live moves
      // someone out of this, and only the operator can do that.
      staged: row.status === 'staged',
      approved_at: row.approved_at || null,
      // Why this person could not go live, if anything (a missing variable,
      // or a cohort with no sequence written yet). Surfaced up front so the
      // gap is visible before pressing go live, not after.
      // An edit that broke the message counts as blocked too — the same field
      // the go-live check and the sheet's red row already read, so a bad edit
      // stops the person by the mechanism that already exists.
      blocked: rendered.blocked
        || (override && (override.missing.length || override.unknown.length)
          ? `edited message has unfilled ${[...override.missing, ...override.unknown].join(', ')}`
          : null),
      answered: !!row.answered_at,
      answered_at: row.answered_at || null,
      step: row.step,
      // How many messages this person has ACTUALLY RECEIVED. `step` is the index
      // of the next one to send, which is the same number — but naming it
      // separately stops the sheet showing 1/3 to someone who has had nothing.
      sent_count: row.step,
      ladder_length: ladder.length,
      last_sent_text: row.last_sent_text || null,
      last_sent_at: row.last_sent_at || null,
      next_text: nextText,
      next_send_at: row.status === 'active' ? row.next_send_at : null,

      // ── the next message, and everything the sheet says about it ──
      // DRAFT = written and waiting, with no send time (nobody has gone live).
      // SCHEDULED = it has a moment it will leave at.
      next_state: row.status === 'staged' ? 'draft'
        : (row.status === 'active' && row.next_send_at) ? 'scheduled'
        : null,
      next_step: nextText === null ? null : shownStep,
      next_send_label: when?.label || null,
      next_send_zone: when?.zone || null,
      next_send_ymd: when?.ymd || null,
      timezone: tz,
      // Scheduled for the cohort's TODAY — the rows the operator has to look at
      // now, which is why they are pinned to the top of their cohort below.
      due_today: !!(when && when.ymd === zonedYmd(now(), tz)),

      // Per-message approval.
      approved: approved,
      approved_step: row.approved_step ?? null,
      // Distinct from `approved_at` above, which is the GO-LIVE stamp: this one
      // is when THIS message was signed off. Naming them the same silently threw
      // the go-live stamp away.
      approved_step_at: row.approved_step_at || null,
      // Whether an approval is required at all is a knowledge-doc setting, and
      // the sheet must show the rule that is actually in force.
      approval_required: !!cadence.require_approval,

      // The operator's inline edit of this one message, if any.
      edited: !!override,
      override_text: override ? row.override_text : null,
      // An edit that introduced an unfillable variable must be visible as a
      // problem here, not discovered at send time.
      override_blocked: override && (override.missing.length || override.unknown.length)
        ? `edited message has unfilled ${[...override.missing, ...override.unknown].join(', ')}`
        : null,

      // Where their real conversation stands: untouched | touched | active | dead.
      conversation: convo.get(row.lead_id)?.status || 'untouched',
      conversation_last_at: convo.get(row.lead_id)?.last_at || null,
      dead_by: convo.get(row.lead_id)?.dead_by || null,
      msgs_in: convo.get(row.lead_id)?.msgs_in || 0,
      msgs_out: convo.get(row.lead_id)?.msgs_out || 0,
      // Nothing left to say — the ladder is spent, not the prospect.
      exhausted: row.status === 'active' && row.step >= ladder.length,
      stop_reason: row.stop_reason || null,
      last_error: row.last_error || null,
    });
  }

  // Anything going out TODAY sits at the top of its cohort, because those are
  // the messages the operator still has time to read, approve or edit. Sorted
  // here rather than in the browser so the order is the same for every reader
  // and cannot drift from the `due_today` flag it is based on.
  //
  // Cohort first, THEN rank: a comparator that returned 0 for members of
  // different cohorts would not be transitive, and Array.sort is free to
  // produce nonsense from one. Grouping by cohort here costs nothing — the
  // caller groups by cohort anyway.
  const rank = (m) => (m.due_today ? 0 : m.next_send_at ? 1 : m.next_state === 'draft' ? 2 : 3);
  const cohortOrder = new Map(cohorts.map((c, i) => [c.id, i]));
  members.sort((a, b) => {
    const c = (cohortOrder.get(a.cohort_id) ?? 999) - (cohortOrder.get(b.cohort_id) ?? 999);
    if (c) return c;
    const r = rank(a) - rank(b);
    if (r) return r;
    // Within a rank, soonest first; unscheduled rows fall back to a stable name.
    if (a.next_send_at && b.next_send_at) return a.next_send_at - b.next_send_at;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const counts = { staged: 0, active: 0, answered: 0, paused: 0, done: 0, stopped: 0 };
  for (const q of members) if (counts[q.status] !== undefined) counts[q.status]++;
  return { members, cohorts, counts, live: await isLive(env) };
}

// ── the tick ────────────────────────────────────────────────────────────────
// Runs on cron. Walks the due enrolments, re-verifies each one against the
// live conversation, and sends at most what the cadence allows.
export async function runCohortTick(env, { force = false, dry_run = null, limit = null } = {}) {
  const { cadence } = await loadCohortCadence(env);
  const live = await isLive(env);
  // dry_run defaults to "whatever the flag says"; an explicit value wins so a
  // caller can preview without touching the flag.
  const dry = dry_run === null ? !live : !!dry_run;
  const t = now();

  if (!force && !withinWindow(t, cadence)) {
    return { ran: false, reason: 'outside the sending window', dry_run: dry, next_open: nextWindowOpening(t, cadence) };
  }

  // Whole-account daily ceiling — the number that stops a bad enrolment
  // becoming a bulk send. Counts real sends only, so dry runs never eat it.
  const dayAgo = t - 86400000;
  const sentToday = Number((await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM outreach_cohort_members WHERE last_sent_at IS NOT NULL AND last_sent_at > ?',
  ).bind(dayAgo).first().catch(() => null))?.n || 0);
  const budget = Math.max(0, cadence.max_sends_per_day - sentToday);
  if (!budget && !dry) {
    return { ran: false, reason: `daily cap reached (${cadence.max_sends_per_day})`, dry_run: dry };
  }

  // A member is only due if THEIR cohort is running. Pausing or cancelling a
  // cohort therefore stops every message inside it at once, with no need to
  // touch the members or lose their place in the sequence.
  // APPROVED ROWS SORT FIRST. This query is LIMITed, so ordering by time alone
  // let twenty-five messages nobody had got round to approving fill the window
  // every tick and permanently mask the approved ones behind them — approving a
  // prospect could never take effect.
  //
  // Ordering rather than EXCLUDING the unapproved, deliberately: an unapproved
  // row still has to be looked at, because the reply check below is what takes
  // someone who answered out of the automation. Filter them out here and a
  // prospect who replied would sit "active" forever, since the one thing that
  // marks them answered never runs on them.
  // (SQLite sorts 1 before 0 before NULL under DESC, which is the order wanted.)
  const order = cadence.require_approval
    ? '(m.approved_step = m.step) DESC, m.next_send_at ASC'
    : 'm.next_send_at ASC';
  const due = ((await env.DB.prepare(
    `SELECT m.* FROM outreach_cohort_members m
       LEFT JOIN outreach_cohorts c ON c.id = m.cohort_id
      WHERE m.status = 'active' AND m.next_send_at IS NOT NULL AND m.next_send_at <= ?
        AND COALESCE(c.status, 'active') = 'active'
      ORDER BY ${order} LIMIT ?`,
  ).bind(t, Math.min(limit || 25, 50)).all().catch(() => ({ results: [] }))).results) || [];

  // Counted separately so a tick that sends nothing can say WHY — an invisible
  // backlog reads as "the sender is broken".
  const awaiting = cadence.require_approval ? Number((await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM outreach_cohort_members m
       LEFT JOIN outreach_cohorts c ON c.id = m.cohort_id
      WHERE m.status = 'active' AND m.next_send_at IS NOT NULL AND m.next_send_at <= ?
        AND COALESCE(c.status, 'active') = 'active'
        AND (m.approved_step IS NULL OR m.approved_step <> m.step)`,
  ).bind(t).first().catch(() => null))?.n || 0) : 0;

  const results = [];
  let sent = 0;
  for (const row of due) {
    if (!dry && sent >= budget) { results.push({ lead_id: row.lead_id, action: 'deferred', reason: 'daily cap' }); continue; }
    const lead = await getLead(env, row.lead_id).catch(() => null);
    if (!lead) {
      await writeRow(env, row.lead_id, { status: 'stopped', stop_reason: 'lead missing', next_send_at: null });
      results.push({ lead_id: row.lead_id, action: 'stopped', reason: 'lead missing' });
      continue;
    }

    // ── THE GUARD ── re-read the conversation NOW. Whatever was true when this
    // step was scheduled is irrelevant; what matters is whether they have
    // spoken since.
    const facts = await threadFacts(env, { chat_id: row.chat_id || chatIdOf(lead), lead, limit: 50 });
    if (facts.answered) {
      await writeRow(env, row.lead_id, {
        status: 'answered', answered_at: facts.last_in_at || t, stop_reason: 'answered', next_send_at: null,
      });
      await logEvent(env, { kind: 'outreach_cohort_answered', payload: { lead_id: row.lead_id, name: lead.name || null } });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'answered — removed from automation' });
      continue;
    }

    const seq = await sequenceOf(env, row.cohort_id);
    const cad = effectiveCadence(cadence, await cohortRow(env, row.cohort_id));
    const rendered = renderSequence(seq, lead);
    // Re-validated at send time, not just at go-live: the cohort's copy or the
    // prospect's fields may have changed since approval, and a message with an
    // unfilled variable must never leave.
    if (rendered.blocked) {
      await writeRow(env, row.lead_id, { status: 'stopped', stop_reason: 'blocked', last_error: rendered.blocked, next_send_at: null });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', error: rendered.blocked });
      continue;
    }
    const step = rendered.steps[row.step];
    // 'always' steps ignore the reply rule — but the answered check above has
    // already removed anyone who replied, so this only matters for a cohort
    // whose earlier steps were skipped.
    if (step && !WIRED_CHANNELS.includes(step.channel)) {
      await writeRow(env, row.lead_id, {
        status: 'stopped', stop_reason: 'channel not wired',
        last_error: `step ${row.step + 1} is set to ${step.channel}, which cannot send yet`, next_send_at: null,
      });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', error: `${step.channel} is not wired to a sender` });
      continue;
    }
    let text = step?.text;
    if (!text) {
      await writeRow(env, row.lead_id, { status: 'done', stop_reason: 'exhausted', next_send_at: null });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'sequence finished' });
      continue;
    }

    // The operator's edit of THIS message for THIS person wins over the cohort's
    // copy — re-rendered here, so an edit that has since become unfillable (the
    // prospect lost a field) stops rather than sending with a hole in it.
    if (row.override_text && row.override_step === row.step) {
      const o = renderBody(row.override_text, lead);
      if (o.missing.length || o.unknown.length) {
        await writeRow(env, row.lead_id, {
          status: 'stopped', stop_reason: 'blocked',
          last_error: `edited message has unfilled ${[...o.missing, ...o.unknown].join(', ')}`, next_send_at: null,
        });
        results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', error: 'edited message cannot be filled in' });
        continue;
      }
      text = o.text;
    }

    // ── THE APPROVAL GATE ── the operator has to have signed off THIS message,
    // not merely this person. Deliberately does NOT clear next_send_at: the row
    // stays due and keeps showing at the top of its cohort until it is approved
    // or removed, so an unapproved message is a visible backlog rather than
    // something that quietly disappeared from the run.
    if (cadence.require_approval && row.approved_step !== row.step) {
      results.push({
        lead_id: row.lead_id, name: lead.name || null, action: 'awaiting approval',
        step: row.step, text,
      });
      continue;
    }

    if (dry) {
      results.push({
        lead_id: row.lead_id, name: lead.name || null, action: 'would send',
        step: row.step, chat_id: row.chat_id, text,
      });
      continue;
    }

    try {
      await sendText(env, { chatId: row.chat_id, text });
      sent++;
      const nextStep = row.step + 1;
      const more = nextStep < rendered.length;
      await writeRow(env, row.lead_id, {
        step: nextStep,
        last_sent_at: now(),
        last_sent_text: text,
        last_error: null,
        status: more ? 'active' : 'done',
        stop_reason: more ? null : 'exhausted',
        // The gap to the next message is the cohort's own, authored beside the copy.
        next_send_at: more ? nextWindowOpening(now() + delayForStep(seq, nextStep), cad) : null,
      });
      await logEvent(env, {
        kind: 'outreach_cohort_sent',
        payload: { lead_id: row.lead_id, name: lead.name || null, step: row.step, chars: text.length },
      });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'sent', step: row.step });
    } catch (e) {
      const err = String(e?.message || e).slice(0, 300);
      // A failed send stops that prospect rather than retrying blindly — a
      // silent retry loop against a broken gateway is how duplicates happen.
      await writeRow(env, row.lead_id, { status: 'stopped', stop_reason: 'failed', last_error: err, next_send_at: null });
      await logEvent(env, { kind: 'outreach_cohort_failed', payload: { lead_id: row.lead_id, error: err } });
      results.push({ lead_id: row.lead_id, name: lead.name || null, action: 'failed', error: err });
    }

    // Human spacing between sends, so a tick never machine-guns the gateway.
    if (!dry && sent < budget) {
      await new Promise((r) => setTimeout(r, Math.min(cadence.min_gap_minutes * 60000, 15000)));
    }
  }

  await logEvent(env, {
    kind: 'outreach_cohort_tick',
    payload: { due: due.length, sent, awaiting_approval: awaiting, dry_run: dry, live },
  });
  return { ran: true, dry_run: dry, live, due: due.length, sent, awaiting_approval: awaiting, results };
}

// ── the tick, as five decisions instead of one function ─────────────────────
// runCohortTick above is a single pass because it grew that way. The
// `outreach-cohort-tick` workflow needs the SAME behaviour as ordered steps an
// operator can read, re-run and audit one at a time, so the decisions are split
// out here: who is due → who has since answered → what would each of them
// receive → which of those did the operator sign off → send.
//
// What is deliberately NOT split is the claim-then-send loop at the end. The
// conversation must be re-read in the moment BEFORE each send and the step must
// advance in the same breath as it; batching those apart would let a reply that
// lands mid-run still collect its follow-up.

// STEP 1 — who is due, and how much room is left in the day.
export async function listDueMembers(env, { force = false, dry_run = null, limit = null } = {}) {
  const { cadence } = await loadCohortCadence(env);
  const live = await isLive(env);
  const dry = (dry_run === null || dry_run === undefined) ? !live : !!dry_run;
  const t = now();

  if (!force && !withinWindow(t, cadence)) {
    return {
      ran: false, reason: 'outside the sending window', due: [], budget: 0,
      dry_run: dry, live, awaiting_approval: 0, next_open: nextWindowOpening(t, cadence),
    };
  }

  // Whole-account daily ceiling — the number that stops a bad enrolment becoming
  // a bulk send. Counts real sends only, so dry runs never eat it.
  const sentToday = Number((await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM outreach_cohort_members WHERE last_sent_at IS NOT NULL AND last_sent_at > ?',
  ).bind(t - 86400000).first().catch(() => null))?.n || 0);
  const budget = Math.max(0, cadence.max_sends_per_day - sentToday);
  if (!budget && !dry) {
    return { ran: false, reason: `daily cap reached (${cadence.max_sends_per_day})`, due: [], budget: 0, dry_run: dry, live, awaiting_approval: 0 };
  }

  // APPROVED ROWS SORT FIRST — this query is LIMITed, so ordering by time alone
  // let unapproved rows fill the window every tick and permanently mask the
  // approved ones behind them. They are ordered rather than excluded because an
  // unapproved row still has to be LOOKED at: the reply check downstream is what
  // takes someone who answered out of the automation.
  const order = cadence.require_approval
    ? '(m.approved_step = m.step) DESC, m.next_send_at ASC'
    : 'm.next_send_at ASC';
  const due = ((await env.DB.prepare(
    `SELECT m.* FROM outreach_cohort_members m
       LEFT JOIN outreach_cohorts c ON c.id = m.cohort_id
      WHERE m.status = 'active' AND m.next_send_at IS NOT NULL AND m.next_send_at <= ?
        AND COALESCE(c.status, 'active') = 'active'
      ORDER BY ${order} LIMIT ?`,
  ).bind(t, Math.min(limit || 25, 50)).all().catch(() => ({ results: [] }))).results) || [];

  // Counted separately so a tick that sends nothing can say WHY — an invisible
  // backlog reads as "the sender is broken".
  const awaiting = cadence.require_approval ? Number((await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM outreach_cohort_members m
       LEFT JOIN outreach_cohorts c ON c.id = m.cohort_id
      WHERE m.status = 'active' AND m.next_send_at IS NOT NULL AND m.next_send_at <= ?
        AND COALESCE(c.status, 'active') = 'active'
        AND (m.approved_step IS NULL OR m.approved_step <> m.step)`,
  ).bind(t).first().catch(() => null))?.n || 0) : 0;

  return { ran: true, due, budget, dry_run: dry, live, awaiting_approval: awaiting };
}

// STEP 2 — anyone who has spoken since leaves the automation, permanently.
// Runs on EVERY due row, approved or not: filtering the unapproved out first
// would leave a prospect who replied sitting 'active' forever, because the one
// thing that marks them answered would never run on them.
export async function retireAnsweredMembers(env, { due = [] } = {}) {
  const t = now();
  const kept = [];
  const retired = [];
  const unverified = [];
  for (const row of due) {
    const lead = await getLead(env, row.lead_id).catch(() => null);
    let facts = null;
    try {
      facts = await threadFacts(env, { chat_id: row.chat_id || chatIdOf(lead), lead, limit: 50 });
    } catch (e) {
      // Fail CLOSED: a conversation we could not read is one we cannot promise
      // is unanswered, so the row is dropped from this pass. Its send time is
      // untouched, so it stays due and is picked up again next tick.
      unverified.push({ lead_id: row.lead_id, name: lead?.name || null, error: String(e?.message || e).slice(0, 300) });
      continue;
    }
    if (!facts.answered) { kept.push(row); continue; }
    await writeRow(env, row.lead_id, {
      status: 'answered', answered_at: facts.last_in_at || t, stop_reason: 'answered', next_send_at: null,
    });
    await logEvent(env, { kind: 'outreach_cohort_answered', payload: { lead_id: row.lead_id, name: lead?.name || null } });
    retired.push({ lead_id: row.lead_id, name: lead?.name || null, answered_at: facts.last_in_at || t });
  }
  return { due: kept, retired, unverified };
}

// STEP 3 — what each of them would actually receive. Fail-closed: a row whose
// message cannot be filled in is STOPPED here rather than sent with a hole in
// it, which is why this runs after approval was given and before the send.
export async function renderMemberMessages(env, { due = [] } = {}) {
  const seqCache = new Map();
  const sendable = [];
  const blocked = [];
  for (const row of due) {
    const lead = await getLead(env, row.lead_id).catch(() => null);
    if (!lead) {
      await writeRow(env, row.lead_id, { status: 'stopped', stop_reason: 'lead missing', next_send_at: null });
      blocked.push({ lead_id: row.lead_id, name: null, action: 'stopped', reason: 'lead missing' });
      continue;
    }
    const qId = row.cohort_id || DEFAULT_COHORT;
    if (!seqCache.has(qId)) seqCache.set(qId, await sequenceOf(env, qId));
    const seq = seqCache.get(qId);
    const rendered = renderSequence(seq, lead);
    if (rendered.blocked) {
      await writeRow(env, row.lead_id, { status: 'stopped', stop_reason: 'blocked', last_error: rendered.blocked, next_send_at: null });
      blocked.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', reason: rendered.blocked });
      continue;
    }
    const step = rendered.steps[row.step];
    if (step && !WIRED_CHANNELS.includes(step.channel)) {
      const reason = `step ${row.step + 1} is set to ${step.channel}, which cannot send yet`;
      await writeRow(env, row.lead_id, { status: 'stopped', stop_reason: 'channel not wired', last_error: reason, next_send_at: null });
      blocked.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', reason });
      continue;
    }
    let text = step?.text;
    if (!text) {
      await writeRow(env, row.lead_id, { status: 'done', stop_reason: 'exhausted', next_send_at: null });
      blocked.push({ lead_id: row.lead_id, name: lead.name || null, action: 'sequence finished', reason: 'the ladder is spent' });
      continue;
    }
    // The operator's edit of THIS message for THIS person wins over the cohort's
    // copy — re-rendered here, so an edit that has since become unfillable (the
    // prospect lost a field) stops rather than sending with a hole in it.
    if (row.override_text && row.override_step === row.step) {
      const o = renderBody(row.override_text, lead);
      if (o.missing.length || o.unknown.length) {
        const reason = `edited message has unfilled ${[...o.missing, ...o.unknown].join(', ')}`;
        await writeRow(env, row.lead_id, { status: 'stopped', stop_reason: 'blocked', last_error: reason, next_send_at: null });
        blocked.push({ lead_id: row.lead_id, name: lead.name || null, action: 'blocked', reason });
        continue;
      }
      text = o.text;
    }
    const nextStep = row.step + 1;
    sendable.push({
      lead_id: row.lead_id, name: lead.name || null, chat_id: row.chat_id,
      cohort_id: qId, step: row.step, approved_step: row.approved_step ?? null, text,
      // Everything the send step needs to arm the FOLLOWING message, resolved
      // here so it never has to re-render a sequence mid-send.
      more: nextStep < rendered.length,
      next_delay_ms: nextStep < rendered.length ? delayForStep(seq, nextStep) : null,
    });
  }
  return { sendable, blocked };
}

// STEP 4 — the approval gate. Approval is per (person, step): sending advances
// `step`, so a stored index stops matching by itself and the next message is
// un-approved by construction.
export async function gateMemberApprovals(env, { sendable = [] } = {}) {
  const { cadence } = await loadCohortCadence(env);
  if (!cadence.require_approval) return { sendable, awaiting: [], approval_required: false };
  const approved = [];
  const awaiting = [];
  for (const m of sendable) {
    if (m.approved_step === m.step) { approved.push(m); continue; }
    // Deliberately NO write: the row keeps its send time, so an unapproved
    // message stays visibly due at the top of its cohort rather than quietly
    // vanishing from the run.
    awaiting.push({ lead_id: m.lead_id, name: m.name, step: m.step, text: m.text });
  }
  return { sendable: approved, awaiting, approval_required: true };
}

// STEP 5 — send. THE LOOP THAT MUST NOT BE SPLIT: for each message the
// conversation is re-read in the moment before it leaves, the step advances in
// the same write as the send, and any failure STOPS that prospect rather than
// re-arming them — a silent retry against a broken gateway is how duplicates
// happen. dry_run reports what would have gone and writes nothing.
export async function sendDueMessages(env, { sendable = [], budget = 0, dry_run = true } = {}) {
  const { cadence } = await loadCohortCadence(env);
  const dry = !!dry_run;
  const cohortCache = new Map();
  const results = [];
  let sent = 0;

  for (const m of sendable) {
    if (!dry && sent >= budget) { results.push({ lead_id: m.lead_id, name: m.name, action: 'deferred', reason: 'daily cap' }); continue; }
    if (dry) {
      results.push({ lead_id: m.lead_id, name: m.name, action: 'would send', step: m.step, chat_id: m.chat_id, text: m.text });
      continue;
    }

    // ── THE GUARD ── whatever was true when this step was rendered is
    // irrelevant; what matters is whether they have spoken since.
    const lead = await getLead(env, m.lead_id).catch(() => null);
    let facts = null;
    try {
      facts = await threadFacts(env, { chat_id: m.chat_id || chatIdOf(lead), lead, limit: 50 });
    } catch (e) {
      results.push({ lead_id: m.lead_id, name: m.name, action: 'held', reason: `could not verify the conversation (${String(e?.message || e).slice(0, 200)})` });
      continue;
    }
    if (facts.answered) {
      await writeRow(env, m.lead_id, {
        status: 'answered', answered_at: facts.last_in_at || now(), stop_reason: 'answered', next_send_at: null,
      });
      await logEvent(env, { kind: 'outreach_cohort_answered', payload: { lead_id: m.lead_id, name: m.name } });
      results.push({ lead_id: m.lead_id, name: m.name, action: 'answered — removed from automation' });
      continue;
    }

    if (!cohortCache.has(m.cohort_id)) cohortCache.set(m.cohort_id, await cohortRow(env, m.cohort_id));
    const cad = effectiveCadence(cadence, cohortCache.get(m.cohort_id));
    try {
      await sendText(env, { chatId: m.chat_id, text: m.text });
      sent++;
      await writeRow(env, m.lead_id, {
        step: m.step + 1,
        last_sent_at: now(),
        last_sent_text: m.text,
        last_error: null,
        status: m.more ? 'active' : 'done',
        stop_reason: m.more ? null : 'exhausted',
        next_send_at: m.more ? nextWindowOpening(now() + (m.next_delay_ms || 0), cad) : null,
      });
      await logEvent(env, {
        kind: 'outreach_cohort_sent',
        payload: { lead_id: m.lead_id, name: m.name, step: m.step, chars: m.text.length },
      });
      results.push({ lead_id: m.lead_id, name: m.name, action: 'sent', step: m.step });
    } catch (e) {
      const err = String(e?.message || e).slice(0, 300);
      await writeRow(env, m.lead_id, { status: 'stopped', stop_reason: 'failed', last_error: err, next_send_at: null });
      await logEvent(env, { kind: 'outreach_cohort_failed', payload: { lead_id: m.lead_id, error: err } });
      results.push({ lead_id: m.lead_id, name: m.name, action: 'failed', error: err });
    }

    // Human spacing between sends, so a run never machine-guns the gateway.
    if (sent < budget) await new Promise((r) => setTimeout(r, Math.min(cadence.min_gap_minutes * 60000, 15000)));
  }

  await logEvent(env, {
    kind: 'outreach_cohort_tick',
    payload: { sendable: sendable.length, sent, dry_run: dry },
  });
  return { sent, results, dry_run: dry };
}
