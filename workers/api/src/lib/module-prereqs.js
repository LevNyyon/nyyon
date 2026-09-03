// What each module NEEDS before it is worth opening — one declarative table.
//
// THE PROBLEM THIS SOLVES
// Setup used to be one long corridor: account, model key, a fifteen-minute
// voice interview, then a screen of API keys, and only then the product. Most
// of that corridor is asking for things the operator has no context for yet.
// Nobody knows what a "point-of-view library" is on minute three, and nobody
// wants to paste a WhatsApp gateway key before they have seen the inbox it
// fills.
//
// So setup now stops at the model key, and everything else has moved to the
// moment it is actually needed. Hot Takes asks for the voice documents when
// you open Hot Takes. Outreach asks for WhatsApp when you open Outreach. This
// file is the table that says which module asks for what, and it is the ONLY
// place that knowledge lives — the pages render whatever it reports.
//
// TWO KINDS OF PREREQUISITE, and one honest distinction between them:
//
//   kind: 'voice'    a knowledge document that must be the OPERATOR'S, not the
//                    placeholder the seed shipped. Writing surfaces read these
//                    on every run, so a module gated on voice does not crash
//                    without it — it writes like nobody, which is worse.
//   kind: 'gateway'  an external service is configured (listGatewayStatus says
//                    so). A module gated on a gateway usually cannot do its
//                    job at all: there is no inbox without WhatsApp.
//
// `requires` is what the gate offers to fix; `optional` is what the module
// would be BETTER with and works fine without. Nothing here ever blocks a
// module — see ModuleSetupGate: every requirement is skippable, and the page
// then renders in whatever degraded state it can manage. This table decides
// what to OFFER, never what to allow.
//
// WHY THIS TABLE IS CODE AND NOT A KNOWLEDGE NOTE
// The guardrail says constants, thresholds and lists live in knowledge notes,
// where an operator can change behaviour without a deploy. This table is the
// same exception lib/gateway-config.js's CREDENTIALS map is, and for the same
// reason: it is a contract WITH the code, not a rule ABOUT it. Editing "blog
// requires brand-voice" in a note could not change which document
// lib/aeo-writer.js actually reads — it would only make the app ask for
// something nobody consumes, or stop asking for something that still throws.
// The one thing this list must never drift from is the source, so it lives
// beside it. The operator-facing WORDS are here for the same reason: they are
// the justification for a specific line of code, and a reason that can drift
// from what it explains is worse than no reason.
//
// WHY THE DECLARATIONS ARE WHAT THEY ARE
// Each one was checked against what the module's code actually reads, not
// against what it sounds like it should read. The `why` string on every entry
// is the operator-facing sentence, and `evidence` (in the table below, as a
// comment) is the code that justifies it. Where the guess and the code
// disagreed, the code won — Outreach is the case: its reply drafting reads the
// `outreach-*` notes and the approved GTM angle, never the voice documents, so
// voice is listed there as a benefit rather than a requirement.

import { readKnowledge } from './db.js';
import { listGatewayStatus } from './gateway-config.js';
import { readInstallState } from './install.js';
import { llmConfigured } from './onboarding.js';

// ── is this knowledge doc the operator's, or still the one we shipped? ──────
//
// The seed stamps a SHA-256 of every body it ships into `seeded_docs`
// (migration 0070). "Still the default" is therefore a fact: hash what is in
// the doc now and compare it with what the seed shipped.
//
// The alternative — matching the placeholder's WORDING — is what this
// deliberately does not do. The old hottakes setup lib carried that heuristic
// (a list of marker phrases in a knowledge note; it lives in the editorial
// plugin now), and it is exactly the failure mode to avoid: the markers are
// prose fragments copied out of the seed, so rewording one line of the seed
// silently makes every check lie, in whichever direction, with nothing failing
// loudly enough to notice. A fingerprint cannot drift, because it is generated
// FROM the shipped body by the same script that ships it.
//
// Four outcomes, in the order they are decided:
//
//   doc absent            → not the operator's (nothing is there)
//   stamped + hash equal  → the shipped placeholder, untouched
//   stamped + hash differs→ theirs (the interview, Nyo, or a hand edit — all
//                           three go through writeKnowledge, all three change
//                           the body)
//   never stamped         → theirs. An unstamped doc was written by something
//                           other than the seed; the only way to be stamped is
//                           to have been shipped.
//
// The last case is also what an install seeded before migration 0070 looks
// like, and it fails OPEN on purpose: reporting an operator who did the
// interview as "still on defaults" would gate every module they own, on every
// page, forever. Re-running the seed (which is idempotent) stamps that install
// and the check becomes exact again.
const enc = new TextEncoder();

async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', enc.encode(String(text)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Fail-soft exactly like install.js: a table that is not there yet means
// "nothing was ever stamped", never an error that takes a module page down.
async function readStamps(env) {
  if (!env?.DB) return new Map();
  try {
    const r = await env.DB.prepare('SELECT slug, fingerprint FROM seeded_docs').all();
    return new Map((r.results || []).map((row) => [row.slug, String(row.fingerprint || '')]));
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) return new Map();
    return new Map();
  }
}

/**
 * Does this slug carry the operator's own material?
 *
 * @returns {{slug: string, exists: boolean, personal: boolean, shipped: boolean}}
 *          `shipped` = we can prove it is still the placeholder we wrote.
 */
async function readDocOwnership(env, slug, stamps) {
  const doc = await readKnowledge(env, slug).catch(() => null);
  const body = String(doc?.body || '');
  if (!doc || !body.trim()) return { slug, exists: false, personal: false, shipped: false };
  const stamped = stamps.get(slug);
  if (!stamped) return { slug, exists: true, personal: true, shipped: false };
  const shipped = (await sha256Hex(body)) === stamped;
  return { slug, exists: true, personal: !shipped, shipped };
}

// ── the voice documents ─────────────────────────────────────────────────────
// The six the setup interview writes (lib/onboarding.js VOICE_SLUGS), plus the
// alternative slugs that predate it: the editorial pack ships the pack-scoped
// `plugin-editorial-hottakes-pov-library` and the interview writes the global
// `pov-library`, and either one counts as "the operator said what they argue".
// The signal-priorities doc lives in the editorial plugin's namespace since
// migration 0074 — the interview writes it there and the pack reads it there.
const VOICE_DOCS = {
  'brand-voice':          { label: 'Brand voice',        alt: null },
  'personal-voice':       { label: 'Personal voice',     alt: null },
  'writing-style-rules':  { label: 'Writing style rules', alt: null },
  'plugin-editorial-heartbeat-priorities': { label: 'What counts as a signal', alt: null },
  'pov-library':          { label: 'Point-of-view library', alt: 'plugin-editorial-hottakes-pov-library' },
  'icp':                  { label: 'Who this is for (ICP)', alt: 'brand-icp' },
};

// Read every voice doc once per request, so a page asking for all module
// statuses costs one pass rather than one per module.
async function readVoice(env) {
  const stamps = await readStamps(env);
  const out = {};
  for (const [slug, def] of Object.entries(VOICE_DOCS)) {
    let info = await readDocOwnership(env, slug, stamps);
    if (!info.personal && def.alt) {
      const altInfo = await readDocOwnership(env, def.alt, stamps);
      if (altInfo.personal) info = { ...altInfo, slug: altInfo.slug };
    }
    out[slug] = { ...info, label: def.label };
  }
  return out;
}

// ── the table ───────────────────────────────────────────────────────────────
//
// One entry per routable surface (web/src/App.tsx NAVS). A module with nothing
// to declare is listed anyway, with empty arrays, so "is this slug real?" and
// "does this slug need anything?" are the same question with one answer.
//
// Every `why` is written to the operator, in their terms, and says what the
// missing thing UNLOCKS rather than what it is. `degraded` is the other half of
// the honesty: what still works if they skip it.
const MODULES = {
  // Hot Takes, Blog and Social ship as the editorial plugin now — the pack's
  // own first-run flow (the setup gateway receipts) carries their asks; the
  // host prereq table only describes host surfaces.

  // Nothing to declare: these run on the operator's own data or on nothing at
  // all, and gating them would be theatre.
  nyo:             { label: 'Nyo',           requires: [], optional: [] },
  knowledge:       { label: 'Knowledge',     requires: [], optional: [] },
  registry:        { label: 'Registry',      requires: [], optional: [] },
  activity:        { label: 'Activity',      requires: [], optional: [] },
  settings:        { label: 'Settings',      requires: [], optional: [] },
};

// ── declaration helpers ─────────────────────────────────────────────────────
// Two tiny constructors so every row in the table above reads as a sentence
// and every row that comes OUT has the same shape, whatever kind it is.
function voice(slugs, why, degraded) {
  return { kind: 'voice', slugs, why, degraded, fix: 'interview' };
}
function gateway(slug, why, degraded) {
  return { kind: 'gateway', slug, why, degraded, fix: 'connect' };
}


// ── resolution ──────────────────────────────────────────────────────────────

// One requirement, resolved against the live install. Returns null when it is
// satisfied — the caller keeps only what is missing.
function resolveVoice(req, voiceDocs, ctx) {
  const missing = req.slugs.filter((s) => !voiceDocs[s]?.personal);
  if (!missing.length) return null;
  return {
    kind: 'voice',
    // Which documents are still ours, with the labels the operator will
    // recognise from the Knowledge tree.
    slugs: missing,
    label: missing.length === 1
      ? (voiceDocs[missing[0]]?.label || missing[0])
      : 'Your voice documents',
    why: req.why,
    degraded: req.degraded,
    // How the gate offers to fix it. The interview is the fix while it is
    // still reachable; once setup is closed for good (install.js stamps that
    // permanently) the documents are edited in Knowledge like any other note,
    // and offering a button that 404s would be worse than offering nothing.
    fix: ctx.interview_available ? 'interview' : 'knowledge',
    interview_available: ctx.interview_available,
    // The interview is itself an LLM call, so a model key is a precondition of
    // the fix, not of the module.
    llm_ready: ctx.llm_ready,
  };
}

function resolveGateway(req, gateways) {
  const g = gateways.get(req.slug);
  if (g?.configured) return null;
  return {
    kind: 'gateway',
    slug: req.slug,
    label: g?.service || req.slug,
    why: req.why,
    degraded: req.degraded,
    fix: 'connect',
    // Everything the connect form needs, from the same resolver the gateways
    // themselves read through. Secret VALUES never appear here (see
    // listGatewayStatus) — a secret field reports only whether it is set.
    fields: (g?.fields || []).map((f) => ({
      key: f.key, label: f.label, required: f.required, secret: f.secret,
      help: f.help, set: f.set, source: f.source,
    })),
    requires: g?.requires || 'all',
  };
}

// A benefit the module would use if it were there. Same shape as a missing
// requirement, so one component can render both.
function resolveOptional(req, { voiceDocs, gateways, ctx, setupDone }) {
  if (req.kind === 'voice') return resolveVoice(req, voiceDocs, ctx);
  if (req.kind === 'gateway') return resolveGateway(req, gateways);
  // 'setup' — a first run the module owns itself. It has no generic fix (the
  // module's own panel is the surface for it), so it is reported and nothing
  // more — and only until the operator has answered that panel, either way.
  // Going on mentioning a decision somebody already made is a nag.
  if (setupDone.has(req.module)) return null;
  return { ...req };
}

// Which modules have had their own first run answered (done OR skipped — both
// are a decision). Same fail-soft rule as everything else here: no table means
// nobody has answered anything.
async function readSetupDone(env) {
  if (!env?.DB) return new Set();
  try {
    const r = await env.DB.prepare('SELECT module FROM module_setup').all();
    return new Set((r.results || []).map((row) => row.module));
  } catch { return new Set(); }
}

async function loadContext(env) {
  const [voiceDocs, status, install, llm_ready, setupDone] = await Promise.all([
    readVoice(env),
    listGatewayStatus(env).catch(() => ({ gateways: [] })),
    readInstallState(env).catch(() => ({ setup_complete: false })),
    llmConfigured(env).catch(() => false),
    readSetupDone(env),
  ]);
  return {
    voiceDocs,
    setupDone,
    gateways: new Map((status.gateways || []).map((g) => [g.slug, g])),
    ctx: {
      // The setup surface closes permanently the moment setup completes, so
      // after that the interview is not a fix any more — Knowledge is.
      interview_available: !install.setup_complete,
      llm_ready,
    },
  };
}

function statusFor(slug, loaded) {
  const def = MODULES[slug];
  if (!def) return null;
  const { voiceDocs, gateways, ctx } = loaded;
  const missing = def.requires
    .map((r) => (r.kind === 'voice' ? resolveVoice(r, voiceDocs, ctx) : resolveGateway(r, gateways)))
    .filter(Boolean);
  const optional = def.optional
    .map((r) => resolveOptional(r, loaded))
    .filter(Boolean);
  return {
    module: slug,
    label: def.label,
    ready: missing.length === 0,
    missing,
    optional,
  };
}

/**
 * What one module needs before it is worth opening.
 *
 * @returns {{module, label, ready, missing: Array, optional: Array}|null}
 *          null for a slug that is not a module.
 */
export async function moduleStatus(env, slug) {
  const key = String(slug || '').trim();
  if (!MODULES[key]) return null;
  return statusFor(key, await loadContext(env));
}

/**
 * The same answer for every module, on one pass over the voice documents and
 * one gateway-status read. This is what a shell asks for when it wants to mark
 * the sidebar; a page asks for its own slug.
 */
export async function allModuleStatus(env) {
  const loaded = await loadContext(env);
  const modules = Object.keys(MODULES).map((slug) => statusFor(slug, loaded));
  return {
    modules,
    // The voice documents as a set, reported once: which are the operator's
    // and which are still ours. A surface that wants to say "4 of 6 written"
    // reads this instead of re-deriving it from the module rows.
    voice: Object.entries(loaded.voiceDocs).map(([slug, d]) => ({
      slug, label: d.label, exists: d.exists, personal: d.personal, shipped: d.shipped,
    })),
    interview_available: loaded.ctx.interview_available,
    llm_ready: loaded.ctx.llm_ready,
    not_ready: modules.filter((m) => !m.ready).map((m) => m.module),
  };
}
