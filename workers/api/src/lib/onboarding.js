// First-run setup — the sequence a new operator walks on a fresh install.
//
// THE ORDER, and why it is this order:
//
//   1. Account   — username + password, a plain form. No model, no
//                  conversation, no waiting. It creates the login and signs
//                  them in, so from here they are INSIDE their own product.
//   2. Model key — a form too, because everything this install writes runs on
//                  a model, the interview below included.
//
// AND THAT IS ALL OF IT. Boot lands in the app after step two.
//
// The interview below (and the services screen after it) used to be steps
// three and four, and boot used to stand on them. They are now
// PREREQUISITES, raised by the module that needs them at the moment it is
// opened: Hot Takes asks for the voice documents when you open Hot Takes,
// Outreach asks for WhatsApp when you open Outreach
// (lib/module-prereqs.js declares which module needs what; the SPA's
// ModuleSetupGate is the surface). Nothing about the conversation changed —
// same engine, same playbook, same routes, same completion write. What
// changed is when the operator meets it: asking someone to describe their
// writing voice for fifteen minutes before they have seen the product is
// asking them to brief a machine they have not met.
//
// Setup is finished (permanently, see install.js) when the documents are
// written. Postponing is a different write and leaves the surface alive —
// and it has to, because the surface is now reached from inside the app for
// the life of the install rather than once at the start.
//
// The interview itself is a tool-using chat loop shaped like chat/index.js,
// with two deliberate differences:
//
//   1. A SMALL dedicated tool set (five verbs), not the ~200-tool pool. The
//      operator has no data yet; the only things worth doing in this session
//      are: record a fact, write a voice doc, look at what is connected, and
//      declare setup done. A big pool here is a distraction and a security
//      surface.
//   2. It runs through the `llm` gateway's json mode instead of the raw
//      Anthropic tool-calling transport, because the gateway is the ONLY
//      sanctioned LLM boundary (nyyon-lite guardrail) and it already carries
//      the circuit-breaker + local fallback. The tool protocol is therefore a
//      JSON envelope, parsed and dispatched here.
//
// NOTHING in this conversation touches a credential any more. The account was
// created two steps earlier, on a form, by a caller that never wrote it to a
// message row — so the transcript is not a credential store by construction
// rather than by redaction.
//
// The PROCEDURE — what to ask, in what order, what each document must contain —
// is NOT in this file. It is loaded from the onboarding-voice-playbook
// knowledge doc (lib/onboarding-playbook.js seeds it). Editing that doc changes
// the interview with no deploy. Everything in this file is mechanics: the loop,
// the tools, the transcript, and the two guardrails the playbook cannot enforce
// on its own (universal rules go in verbatim; a doc is never saved before the
// operator has seen the draft).

import { callGateway } from '../gateways/index.js';
import { llmTransportAnthropic } from './anthropic.js';
import { noteLlmOk } from './llm.js';
import { writeKnowledge, logEvent } from './db.js';
import { uid, now, safeJSON } from './util.js';
import {
  loadOnboardingPlaybook, UNIVERSAL_STYLE_RULES, UNIVERSAL_PERSONAL_RULES,
} from './onboarding-playbook.js';
import {
  readInstallState, setAdminCredentials, markSetupComplete, deferSetup, resumeSetup,
} from './install.js';
import { listGatewayStatus, saveGatewayConfig, resolveCredential } from './gateway-config.js';

// Is there a model key at all? Cheap: a key's PRESENCE decides whether the
// interview can be offered; whether it WORKS is proved separately by
// verifyLlmKey, which spends a real (tiny) request to find out.
export async function llmConfigured(env) {
  try {
    if (await resolveCredential(env, 'ANTHROPIC_API_KEY')) return true;
  } catch { /* fall through to the backup check */ }
  // A connected backup brain COUNTS — and the check must ask the gateway
  // registry, never a named table. It peeked at free-llm's table, so a key
  // stored by the gemini pack (its OWN table) left llm_ready false and boot
  // bounced the operator back onto the model step forever: verified,
  // configured, stuck. Any plugin advertising llm-backup satisfies this.
  try {
    const { pickBackupLlm } = await import('../gateways/index.js');
    return !!(await pickBackupLlm(env));
  } catch { return false; }
}

// Save a model key and PROVE it before letting the operator past this step.
// An unverified key means the next screen dies with a wall of nothing and no
// explanation, which is the worst possible first minute with a product.
export async function saveAndVerifyLlmKey(env, { key, provider = 'anthropic' }) {
  const clean = String(key || '').trim();
  if (!clean) return { ok: false, error: 'Paste your API key to continue.' };

  const field = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  await saveGatewayConfig(env, 'llm', { [field]: clean, ...(provider === 'openai' ? { LLM_PROVIDER: 'openai' } : {}) });

  try {
    // Verify against the provider DIRECTLY, bypassing the circuit breaker.
    //
    // The breaker protects running jobs: one failure marks the model down and
    // routes everything to the local fallback. During setup that is exactly
    // wrong — a mistyped key trips it, and then the CORRECT key cannot be
    // verified either ("local model unavailable"), so one typo locks the
    // operator out of the step with an error about a fallback they have never
    // heard of. A key check is a probe, not production traffic.
    const r = await llmTransportAnthropic(env, {
      model: env.ANTHROPIC_MODEL || 'claude-opus-5',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ok' }],
    }, { timeoutMs: 30_000 });

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${body.slice(0, 200)}`);
    }
    // A working key also proves the model is reachable, so clear any "down"
    // an earlier bad attempt recorded.
    await noteLlmOk(env).catch(() => {});
    return { ok: true, provider, verified: true };
  } catch (e) {
    // Roll the bad key back out so a retry starts clean rather than layering
    // a second wrong value over a first.
    await saveGatewayConfig(env, 'llm', { [field]: '' }).catch(() => {});
    const msg = String(e?.message || e);
    const friendly = /401|403|invalid|authentication|x-api-key/i.test(msg)
      ? 'That key was rejected by Anthropic. Check you pasted the whole key.'
      : /timed out|timeout|abort/i.test(msg)
        ? 'Could not reach Anthropic — the request timed out. Check your connection and try again.'
        : `Could not verify the key: ${msg.slice(0, 160)}`;
    return { ok: false, error: friendly };
  }
}

// ── the four state transitions ──────────────────────────────────────────────
// Thin, named, and all in one place so the routes never import the install
// store directly and every transition lands on the activity bus exactly once
// (install.js logs them).

// STEP ONE. Creates the login; the ROUTE issues the session cookie afterwards.
// Refuses on an install with no GATE_SECRET rather than handing the operator a
// credential no session could ever be signed with: they would set a password,
// get a 500 on the way in, and be locked out of a product they just installed.
export async function createOperatorAccount(env, { username, password } = {}) {
  if (!env.GATE_SECRET) {
    throw new Error('cannot create the account: GATE_SECRET is not configured on this install, so no sign-in session could be issued. Set it (the installer generates it) and try again.');
  }
  const r = await setAdminCredentials(env, { username, password });
  return { ok: true, username: r.username };
}

// THE LAST STEP. Closes setup permanently.
//
// Refuses while nothing has been written, and the refusal is here rather than
// in either caller so the guide and the operator's own button cannot disagree
// about it. Finishing on an empty transcript would leave the install running
// the shipped default voice documents AND destroy the only surface that can
// replace them — the operator would have to edit six knowledge docs by hand to
// undo one click. Postponing is what that moment is for.
export async function finishSetup(env, { reason = 'interview' } = {}) {
  let docs = [];
  try { docs = savedDocsFrom(await loadTranscript(env)); } catch { /* no transcript yet = nothing written */ }
  if (!docs.length) {
    throw new Error('no voice document has been written yet. Finishing now would close setup on the shipped defaults with no way back. Postpone it instead, and the app will offer the way in again.');
  }
  const r = await markSetupComplete(env, { reason: String(reason || 'interview').slice(0, 40) });
  return { ok: true, docs_saved: docs, ...r };
}

// "Later." Leaves the surface alive so the offer to come back is real.
export async function postponeSetup(env) {
  return deferSetup(env);
}

// Coming back to it.
export async function reopenSetup(env) {
  return resumeSetup(env);
}

// One install, one setup conversation. A fixed id is what makes a browser
// refresh RESUME instead of restarting: the transcript lives in D1, not in the
// page. It is also what makes "finish this later, from inside the app" work —
// the thread an operator abandoned in week one is the thread they come back
// to. `agent` scopes it so it never shows up in the Nyo history panel.
const ONBOARDING_CONVERSATION_ID = 'onboarding';
const AGENT = 'onboarding';

const MAX_HOPS = 4;                 // model → tools → model, per turn
const MAX_PROMPT_CHARS = 48_000;    // transcript budget (samples get long)
// The docs the interview produces. The first three are the voice; the rest are
// the same answers pointed at the modules that steer on them — the awareness
// feed only knows what to watch because the operator said what they own, and
// Hot Takes only has a position to take because they said what their market
// gets wrong. Writing the voice and leaving these generic is what leaves a
// fresh install full of somebody else's topics.
const VOICE_SLUGS = [
  'brand-voice', 'personal-voice', 'writing-style-rules',
  // What counts as a signal worth surfacing. The awareness engine ships in the
  // editorial plugin and reads the doc under ITS namespace (migration 0074
  // moved the slug), so the interview writes it where the reader looks.
  'plugin-editorial-heartbeat-priorities',
  'pov-library',            // the positions Hot Takes argues from
  'icp',                    // who this is for (prospecting + outreach)
];
const PROFILE_SLUG = 'company-profile';
// How many saved docs mean the drafting phase is behind them. A progress
// heuristic for the rail only — what the interview must actually produce is
// the playbook's business, not this file's.
const DRAFTS_DONE_AT = 2;

// ── the tool contract handed to the model ───────────────────────────────────
// Mechanics, not procedure: the JSON envelope and the five verbs. The playbook
// says WHEN to use them.
const PROTOCOL = `## How you reply

You are talking to the operator through a chat box, and you can act on this
install by emitting tool calls. Reply with ONE JSON object and nothing else:

{
  "reply":   "what you say to the operator, in markdown. Never empty.",
  "actions": [ { "tool": "<tool name>", "input": { ... } } ],
  "step":    "facts | samples | positions | drafts | gateways | done",
  "done":    false
}

"actions" is optional and usually empty — most turns are just a question.
After your actions run you are called again with their results, so you can
report what happened. You get at most ${MAX_HOPS} rounds of that per turn.

## Your tools

- save_profile_fact({ key, value })
  One fact about the operator's business. Keys are short and stable:
  company_name, company_url, audience, offer, one_liner. Call it the moment you
  learn something; never batch the whole interview to the end.

- save_voice_doc({ slug, title, body })
  Writes one of the knowledge docs the playbook describes. The body is full
  markdown.
  HARD RULE: you may not save a doc the operator has not seen. First put the
  complete draft in your "reply" with the marker [draft:<slug>] on its own first
  line, ask them to confirm or change it, and only call save_voice_doc after
  they answer. A save without a prior shown draft is refused.
  Do NOT write the universal rules into the body yourself — they are appended
  verbatim by the system. Write only what this operator's interview produced.

- list_gateways()
  Read-only, and rarely needed: which external services this install has
  already connected. You may mention what is connected. You must NOT collect
  credentials — see below.

- finish_setup()
  The LAST action of the session, and the only irreversible one: it marks setup
  complete and this conversation stops being reachable. Call it only after the
  documents are saved and the operator has been through the services screen.
  Say plainly, in the same turn, that everything you wrote is editable
  afterwards in the Knowledge module.

## Connecting services is NOT your job

The operator connects WhatsApp, LinkedIn and the rest on a dedicated screen
with real form fields, because an API key is copy-paste work and a chat is a
terrible place to do it. Never ask for a key, a token, a URL or a secret. Never
read one back.

When the voice documents are saved, say one short line that services come next,
and set "step" to "gateways". The app takes over from there and returns the
operator to you when they are done or have skipped. Then call finish_setup.

## Credentials are NOT your job either

The operator already has an account. They created it on a form before you ever
spoke, and they are signed in right now — that is why they can see this. Never
ask for a username or a password, never offer to change one, and never treat
setting a login as a step of this conversation. It is already done.

## Your very first message

They have installed this, made an account and connected a model, and may still
not know what it IS. Open by saying what a Command Center is, in two or three
short sentences, then ask the first question. Cover only: it runs their
outreach, writing and publishing from one place; it writes in their voice,
which is what this conversation is for; it takes about fifteen minutes, and
they can stop any time and pick it up later from inside the app. Do not list
modules, do not sell, do not explain the architecture. Then go straight to the
first question from the playbook.

## They can leave

They are already inside the product, so this interview is the one part of setup
they can walk away from. If they say they want to stop, do not bargain and do
not squeeze in one more question. Tell them plainly that the app keeps the
default voice documents until this is finished, that the thread is saved
exactly here, and that Settings has the way back. Then stop.

## Manner

Plain, direct, one question at a time. No bullet-point interrogations, no
"Great question!", no emoji. You are a colleague setting up their desk, not a
form. Keep replies short; the operator is typing, not reading an essay.`;

// ── system prompt ───────────────────────────────────────────────────────────
async function buildSystem(env) {
  const playbook = await loadOnboardingPlaybook(env);
  return [
    'You are the setup guide for a freshly installed Nyyon Command Center. The operator has already created their account and connected a model; they are signed in and looking at this conversation inside their own install. By the end of it the system knows who they are, how they write, what they believe, and which external services it may use.',
    '',
    '# The playbook (your procedure — follow it in order)',
    '',
    playbook,
    '',
    '# Universal rules (ship VERBATIM — NEVER ask the operator about any of this)',
    '',
    'These two blocks are appended to the documents automatically. They are anti-AI-tell rules, identical for every install. Do not paraphrase them, do not put them in a draft you show, and above all do not ask the operator whether they want them.',
    '',
    '--- writing-style-rules universal block ---',
    UNIVERSAL_STYLE_RULES,
    '--- personal-voice universal block ---',
    UNIVERSAL_PERSONAL_RULES,
    '--- end universal blocks ---',
    '',
    PROTOCOL,
  ].join('\n');
}

// ── transcript (D1, so a refresh resumes) ───────────────────────────────────
async function ensureConversation(env) {
  const exists = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ?')
    .bind(ONBOARDING_CONVERSATION_ID).first();
  if (exists) {
    await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .bind(now(), ONBOARDING_CONVERSATION_ID).run();
    return false;
  }
  try {
    await env.DB.prepare(
      'INSERT INTO conversations (id, title, agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(ONBOARDING_CONVERSATION_ID, 'Setup', AGENT, now(), now()).run();
  } catch {
    // Pre-0059 database without the `agent` column — still resumable, just
    // unscoped. Better than refusing to onboard.
    await env.DB.prepare(
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).bind(ONBOARDING_CONVERSATION_ID, 'Setup', now(), now()).run();
  }
  return true;
}

async function appendMessage(env, role, content, extra = {}) {
  const id = uid();
  await env.DB.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, tool_name, tool_input, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, ONBOARDING_CONVERSATION_ID, role,
    typeof content === 'string' ? content : JSON.stringify(content),
    extra.tool_name || null,
    extra.tool_input ? JSON.stringify(extra.tool_input) : null,
    now(),
  ).run();
  return id;
}

async function loadTranscript(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, role, content, tool_name, created_at FROM messages
      WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`,
  ).bind(ONBOARDING_CONVERSATION_ID).all();
  return results || [];
}

// ── derived state ───────────────────────────────────────────────────────────
function toolRows(rows, name) {
  return rows.filter((r) => r.role === 'tool' && r.tool_name === name)
    .map((r) => safeJSON(r.content))
    .filter((x) => x && typeof x === 'object');
}

// Facts are re-derived from the transcript rather than kept in a second table:
// the conversation IS the record, so there is nothing to keep in sync.
function factsFrom(rows) {
  const map = {};
  for (const r of toolRows(rows, 'save_profile_fact')) {
    if (r.ok && r.key) map[r.key] = r.value;
  }
  return map;
}
function savedDocsFrom(rows) {
  const set = new Set();
  for (const r of toolRows(rows, 'save_voice_doc')) if (r.ok && r.slug) set.add(r.slug);
  return [...set];
}
function connectedFrom(rows) {
  const set = new Set();
  for (const r of toolRows(rows, 'connect_gateway')) if (r.ok && r.slug) set.add(r.slug);
  return [...set];
}

// Which slugs have been SHOWN to the operator as a draft, and answered since.
// This is the mechanical half of "show the draft before you save it".
const DRAFT_MARKER = /\[draft:([a-z-]+)\]/gi;
function confirmedDrafts(rows) {
  const shown = new Map();       // slug -> index of the assistant row that showed it
  const ok = new Set();
  rows.forEach((r, i) => {
    if (r.role === 'assistant') {
      const text = String(r.content || '');
      for (const m of text.matchAll(DRAFT_MARKER)) shown.set(m[1].toLowerCase(), i);
    } else if (r.role === 'user') {
      // Any operator message AFTER a draft was shown counts as them having
      // seen it and responded. The model still has to read the answer.
      for (const [slug, at] of shown) if (i > at) ok.add(slug);
    }
  });
  return ok;
}

// Where the operator is in the SEQUENCE, not just in the interview: the first
// two answers here are the account and the key, which are forms the app owns.
function deriveStep({ install, llmReady, rows, facts, docs }) {
  if (install.setup_complete) return 'done';
  if (!install.has_admin) return 'account';
  if (!llmReady) return 'llm-key';
  if (!rows.length) return 'welcome';
  if (docs.length >= DRAFTS_DONE_AT) return 'gateways';
  if (docs.length) return 'drafts';
  if (Object.keys(facts).length >= 3) return 'interview';
  return 'facts';
}

/**
 * Where setup stands.
 *
 * Two projections on purpose. The SPA has to ask this BEFORE anyone has proved
 * anything — it is how it picks the boot screen — so the default answer carries
 * only how far this install has been claimed, which leaks nothing. The
 * interview's contents (company name, url, audience, which gateways are wired)
 * are the operator's business data and come back only once the caller has
 * passed verifySetupAccess.
 *
 * @param {boolean} detail  caller has proved setup access
 */
export async function onboardingState(env, { detail = false } = {}) {
  const install = await readInstallState(env);
  let rows = [];
  try { rows = await loadTranscript(env); } catch { /* table not there yet */ }
  const facts = factsFrom(rows);
  const docs = savedDocsFrom(rows);
  // The interview IS an LLM conversation, so without a working model key
  // nothing here can run — not even the greeting. The UI needs to know that
  // BEFORE it renders a chat box that could only ever fail.
  const llm_ready = await llmConfigured(env);
  const base = {
    // Boot lands on the setup surface only while there is a step left that the
    // operator has not chosen to postpone. A postponed install boots into the
    // app and carries a banner back here instead.
    needed: install.needs_setup,
    llm_ready,
    has_admin: Boolean(install.has_admin),
    setup_complete: Boolean(install.setup_complete),
    setup_deferred: Boolean(install.setup_deferred),
    setup_token_set: Boolean(install.setup_token_set),
    install_id: install.install_id || null,
    step: deriveStep({ install, llmReady: llm_ready, rows, facts, docs }),
    conversation_id: ONBOARDING_CONVERSATION_ID,
    // A count, not the content: enough for the UI to know a session is already
    // in flight and offer "resume".
    message_count: rows.filter((r) => r.role !== 'tool').length,
  };
  if (!detail) return base;
  return {
    ...base,
    facts,
    docs_saved: docs,
    gateways_connected: connectedFrom(rows),
  };
}

// The transcript the UI replays on a refresh. Tool rows are included so the
// page can show "connected WhatsApp" beats, but never the raw tool input.
export async function onboardingTranscript(env) {
  const rows = await loadTranscript(env).catch(() => []);
  return {
    conversation_id: ONBOARDING_CONVERSATION_ID,
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.role === 'assistant' ? stripMarkers(String(r.content || '')) : String(r.content || ''),
      tool_name: r.tool_name || null,
      created_at: r.created_at,
    })),
  };
}

function stripMarkers(text) {
  return text.replace(/^[ \t]*\[draft:[a-z-]+\][ \t]*\r?\n?/gim, '').trim();
}

// ── the tools ───────────────────────────────────────────────────────────────

function normalizeKey(k) {
  return String(k || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function labelFor(key) {
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

// Regenerated whole every time a fact lands — the doc is a projection of the
// fact map, so it can never drift from it.
async function writeProfileDoc(env, facts) {
  const lines = Object.entries(facts).map(([k, v]) => `- **${labelFor(k)}** — ${String(v).trim()}`);
  const body = [
    '# Company profile',
    '',
    'Captured during setup. Every writing surface in this system reads it, so keep it true. Edit it freely.',
    '',
    ...(lines.length ? lines : ['_Nothing captured yet._']),
    '',
  ].join('\n');
  await writeKnowledge(env, {
    slug: PROFILE_SLUG, title: 'Company profile', body, parent_slug: 'knowledge-root',
  });
}

// The universal blocks are welded on here, not in the prompt, so no wording the
// model chooses can water them down or drop them.
function composeVoiceBody(slug, body) {
  const written = String(body || '').trim();
  if (slug === 'writing-style-rules') {
    if (written.includes('## Banned phrases')) return written;   // already carries the block verbatim
    return [written, '', '## Universal rules', '', UNIVERSAL_STYLE_RULES].filter(Boolean).join('\n');
  }
  if (slug === 'personal-voice') {
    if (written.includes('## RULE ZERO')) return written;
    return [UNIVERSAL_PERSONAL_RULES, '', written].filter(Boolean).join('\n\n');
  }
  return written;
}

const TITLES = {
  'brand-voice': 'Brand voice',
  'personal-voice': 'Personal voice',
  'writing-style-rules': 'Writing style rules',
};

async function runOnboardingTool(env, name, input, ctx) {
  const arg = (input && typeof input === 'object') ? input : {};
  switch (name) {
    case 'save_profile_fact': {
      const key = normalizeKey(arg.key);
      const value = String(arg.value ?? '').trim();
      if (!key) return { ok: false, error: 'key required' };
      if (!value) return { ok: false, error: 'value required' };
      const facts = { ...ctx.facts, [key]: value };
      ctx.facts = facts;
      await writeProfileDoc(env, facts);
      await logEvent(env, { kind: 'onboarding_fact_saved', actor: 'operator', payload: { key } });
      return { ok: true, key, value, saved_to: PROFILE_SLUG };
    }

    case 'save_voice_doc': {
      const slug = String(arg.slug || '').trim().toLowerCase();
      if (!VOICE_SLUGS.includes(slug)) {
        return { ok: false, error: `slug must be one of: ${VOICE_SLUGS.join(', ')}` };
      }
      if (!String(arg.body || '').trim()) return { ok: false, error: 'body required' };
      if (!ctx.confirmed.has(slug)) {
        return {
          ok: false,
          error: 'refused: the operator has not seen this draft yet',
          fix: `Put the full draft in your reply with [draft:${slug}] on the first line, ask them to confirm or change it, and call save_voice_doc after they answer.`,
        };
      }
      const body = composeVoiceBody(slug, arg.body);
      await writeKnowledge(env, {
        slug,
        title: String(arg.title || TITLES[slug] || slug),
        body,
        parent_slug: 'knowledge-root',
      });
      await logEvent(env, { kind: 'onboarding_doc_saved', actor: 'operator', payload: { slug } });
      return { ok: true, slug, chars: body.length, editable_at: `Knowledge → ${slug}` };
    }

    case 'list_gateways': {
      const s = await listGatewayStatus(env);
      return { ok: true, ...s };
    }

    case 'connect_gateway': {
      const slug = String(arg.slug || '').trim();
      if (!slug) return { ok: false, error: 'slug required' };
      try {
        const r = await saveGatewayConfig(env, slug, arg.config || {});
        return { ok: true, ...r };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }

    case 'finish_setup': {
      // The empty-transcript refusal lives in finishSetup, shared with the
      // operator's own finish button. Here it just becomes an instruction the
      // model can act on.
      try {
        const r = await finishSetup(env, { reason: 'interview' });
        ctx.finished = true;
        return { ok: true, setup_complete: true, ...r };
      } catch (e) {
        return {
          ok: false,
          error: String(e?.message || e),
          fix: 'Finish the drafts with the operator and save them first. If they want to stop now, say so plainly and leave setup open — the app offers them the way back.',
        };
      }
    }

    default:
      return { ok: false, error: `unknown tool "${name}"` };
  }
}

// ── the loop ────────────────────────────────────────────────────────────────

function renderTranscript(rows) {
  const parts = [];
  for (const r of rows) {
    const c = String(r.content || '');
    if (r.role === 'user') parts.push(`OPERATOR: ${c}`);
    else if (r.role === 'assistant') parts.push(`YOU: ${c}`);
    else if (r.role === 'tool') parts.push(`TOOL RESULT (${r.tool_name}): ${c.slice(0, 1200)}`);
  }
  let text = parts.join('\n\n');
  if (text.length > MAX_PROMPT_CHARS) {
    // Trim from the middle: the opening turns anchor the interview, the recent
    // ones are the live thread. Samples in between are already extracted.
    const head = text.slice(0, 6000);
    const tail = text.slice(-(MAX_PROMPT_CHARS - 6000));
    text = `${head}\n\n… [earlier turns trimmed] …\n\n${tail}`;
  }
  return text;
}

// No "they resumed" hint here on purpose. Coming back to a postponed interview
// looks IDENTICAL to any other turn from the model's side — the transcript is
// intact and the operator's next message is just the next message — so a flag
// would only ever fire on a turn that did not need it. How to treat a returning
// operator is a matter of procedure, and it lives in the playbook.
function stateBlock({ facts, docs, connected, step }) {
  return [
    '# Where this session already is',
    `Step: ${step}`,
    `Facts captured: ${Object.keys(facts).length ? JSON.stringify(facts) : 'none yet'}`,
    `Voice docs saved: ${docs.length ? docs.join(', ') : 'none yet'}`,
    `Gateways connected: ${connected.length ? connected.join(', ') : 'none yet'}`,
    '',
    'Do not re-ask anything already captured above. Pick up where the transcript stops.',
  ].join('\n');
}

async function askModel(env, { system, transcript, state, observations }) {
  const prompt = [
    state,
    '',
    '# Conversation so far',
    '',
    transcript || '(nothing yet — this is your opening message)',
    ...(observations ? ['', '# Results of the actions you just took', '', observations] : []),
    '',
    'Reply with the JSON object described in your instructions. Nothing else.',
  ].join('\n');

  const out = await callGateway(env, 'llm', 'json', { system, prompt, max_tokens: 4000 });
  if (!out || typeof out !== 'object') throw new Error('the model returned no usable JSON');
  return out;
}

/**
 * One turn of the setup conversation.
 *
 * @param {object} env
 * @param {{messages?: Array<{role:string, content:string}>}} args
 *        `messages` follows the chat/index.js shape. The SERVER's stored
 *        transcript is authoritative — only the last operator message is taken
 *        from the request — so a doctored history cannot rewrite the session.
 * @returns {{reply:string, state:object, done:boolean, actions:Array}}
 */
export async function runOnboardingTurn(env, { messages = [] } = {}) {
  const install = await readInstallState(env);
  if (install.setup_complete) {
    return {
      reply: 'Setup is already complete on this install. Everything it wrote is in the Knowledge module, and you can edit any of it there.',
      state: await onboardingState(env, { detail: true }),
      done: true,
      actions: [],
    };
  }
  // The interview cannot run before the account exists: the routes are open in
  // that window to anyone with the setup token, and there is no operator to
  // interview yet.
  if (!install.has_admin) {
    return {
      reply: 'Create your account first. It takes ten seconds, and then we can talk.',
      state: await onboardingState(env, { detail: true }),
      done: false,
      actions: [],
    };
  }

  const first = await ensureConversation(env);
  if (first) await logEvent(env, { kind: 'onboarding_started', actor: 'operator', payload: {} });

  // Take the operator's newest message off the request; ignore the rest.
  const incoming = [...messages].reverse().find((m) => m?.role === 'user' && String(m.content || '').trim());
  if (incoming) await appendMessage(env, 'user', String(incoming.content));

  const system = await buildSystem(env);
  const replies = [];
  const actionsRun = [];
  const ctx = { facts: {}, docs: [], confirmed: new Set(), finished: false };
  let observations = null;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const rows = await loadTranscript(env);
    ctx.facts = factsFrom(rows);
    ctx.confirmed = confirmedDrafts(rows);
    ctx.docs = savedDocsFrom(rows);
    const connected = connectedFrom(rows);
    const step = deriveStep({ install, llmReady: true, rows, facts: ctx.facts, docs: ctx.docs });

    let out;
    try {
      out = await askModel(env, {
        system,
        transcript: renderTranscript(rows),
        state: stateBlock({ facts: ctx.facts, docs: ctx.docs, connected, step }),
        observations,
      });
    } catch (e) {
      const msg = `I could not reach the language model just now (${String(e?.message || e).slice(0, 160)}). Nothing was lost — say anything and I will pick up where we left off.`;
      await appendMessage(env, 'assistant', msg);
      return { reply: msg, state: await onboardingState(env, { detail: true }), done: false, actions: actionsRun, error: String(e?.message || e) };
    }

    const reply = String(out.reply || '').trim();
    if (reply) {
      replies.push(reply);
      await appendMessage(env, 'assistant', reply);
    }

    const actions = Array.isArray(out.actions) ? out.actions.slice(0, 6) : [];
    if (!actions.length) break;

    const results = [];
    for (const a of actions) {
      const name = String(a?.tool || a?.name || '');
      const input = a?.input || a?.arguments || {};
      let result;
      try {
        result = await runOnboardingTool(env, name, input, ctx);
      } catch (e) {
        result = { ok: false, error: String(e?.message || e) };
      }
      await appendMessage(env, 'tool', JSON.stringify(result), { tool_name: name, tool_input: input });
      actionsRun.push({ tool: name, ok: Boolean(result.ok) });
      results.push(`${name}: ${JSON.stringify(result).slice(0, 900)}`);
    }
    observations = results.join('\n');
    if (ctx.finished) break;
  }

  const state = await onboardingState(env, { detail: true });
  return {
    reply: stripMarkers(replies.join('\n\n')) || 'Still here. Tell me a bit more.',
    state,
    done: Boolean(state.setup_complete),
    actions: actionsRun,
  };
}

// Thin pass-throughs so the routes never import the store libs directly and the
// onboarding surface stays one module wide.
export async function onboardingGateways(env) {
  return listGatewayStatus(env);
}
export async function connectOnboardingGateway(env, slug, config) {
  const r = await saveGatewayConfig(env, slug, config || {});
  // Mirror it into the transcript so the conversation (and the derived state)
  // knows about a gateway the operator connected through the UI panel rather
  // than by talking to the guide.
  try {
    await ensureConversation(env);
    await appendMessage(env, 'tool', JSON.stringify({ ok: true, slug: r.slug, configured: r.configured }), {
      tool_name: 'connect_gateway', tool_input: { slug },
    });
  } catch { /* the connection itself already succeeded — never fail on the log */ }
  return r;
}
