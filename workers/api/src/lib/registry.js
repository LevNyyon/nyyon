// Live system registry — the honest answer to "what's actually wired up".
//
// This REPLACES the old hand-maintained `modules` + `tools` D1 tables (which
// drifted out of sync with reality). Everything here is derived from the
// running system:
//   • gateways  — the external-service boundaries (code-defined list, finite +
//                 stable, with a live "configured?" flag from env)
//   • tools     — Nyo's REAL tool registry (visibleToolDefs), grouped by domain
//   • workflows — the scheduled + on-demand orchestrations
// plus, for each, the knowledge_docs it reads at runtime (the "edit this doc →
// changes this behaviour" map).
//
// Add a gateway/workflow row here when a new external dependency or orchestration
// is wired in. The tool list needs no maintenance — it is the live registry.

import { listGateways } from '../gateways/index.js';
import { listWorkflows } from './db.js';
import { listGatewayStatus } from './gateway-config.js';

// ── Gateways ────────────────────────────────────────────────────────────────
// The gateway LIST is live — derived from the code registry in
// gateways/index.js (one slug per external service). This META map only adds
// what the code registry doesn't carry: kind, and the knowledge docs each
// gateway reads.
// kind: tunnel = self-hosted service behind a Cloudflare tunnel; saas = a paid
// external API; public-api = keyless external API; binding = Cloudflare binding.
//
// The CONFIG KEYS are deliberately NOT listed here any more. They used to be a
// second hand-maintained copy of the same facts, and a second copy drifts: the
// "configured?" flag on the system map was an env-only check, so a gateway the
// operator connected through the onboarding chat (credentials in D1) rendered
// as missing. Keys and readiness now come from listGatewayStatus() — the same
// resolver the gateways themselves read through.
const GATEWAY_META = {
  llm:      { kind: 'saas',       knowledge: [] },
  social:   { kind: 'saas',       knowledge: [] },
  linkedin: { kind: 'tunnel',     knowledge: [] },
  image:    { kind: 'saas',       knowledge: [] },
  assets:   { kind: 'binding',    knowledge: [] },
  // prompt-wa-reply moved into the editorial plugin (it steers the pack's
  // digest extraction, not any host WA tool), so the host WA entry cites no
  // knowledge doc any more.
  whatsapp: { kind: 'tunnel',     knowledge: [] },
  tts:      { kind: 'tunnel',     knowledge: ['nyo-voice'] },
  telegram: { kind: 'saas',       knowledge: ['nyo-telegram'] },
  web:      { kind: 'public-api', knowledge: [] },
  pdl:      { kind: 'saas',       knowledge: [] },
  twilio:   { kind: 'saas',       knowledge: [] },
  serp:     { kind: 'saas',       knowledge: [] },
  theorg:   { kind: 'public-api', knowledge: [] },
  hf:       { kind: 'saas',       knowledge: ['llm-models'] },
};

// ── Workflows — the real orchestrations, grounded in code (handleScheduled in
// index.js, the event hooks, the client pollers, and the multi-step endpoints).
// kind orders them: automated (fires itself) → continuous (runs while the app is
// open) → event (fires on a trigger) → on-demand (operator/Nyo starts it).
// `has_last_run` = has an observable last-run timestamp (attached below).
const WORKFLOWS = [
  // ── automated (cron) ──
  // Pack cron legs run by tool name with a pack-missing guard — an installed
  // pack's legs fire, an absent pack's skip silently. The pack describes them.
  { name: 'Meeting reminders', kind: 'automated', trigger: 'cron · 0 * * * *',
    steps: 'scan calendar_events, WhatsApp the operator a reminder N minutes before a meeting (no-op until a reminder chat is set)',
    touches: 'calendar_events, wa (via outbox)', knowledge: [], run_slug: 'meeting-reminders' },

  // ── continuous (client, while the app is open) ──
  { name: 'Nyo pending poller', kind: 'continuous', trigger: 'client · every 30s',
    steps: 'poll /api/nyo/pending, inject any queued Nyo message into the chat, mark it delivered',
    touches: 'nyo_messages', knowledge: [] },
  { name: 'Nyo wake-up', kind: 'continuous', trigger: 'client · on mount + tab focus',
    steps: 'pull WhatsApp from the gateway → survey setup state + failures + actions → queue a briefing or the interview invitation (idempotent; skips if nothing changed)',
    touches: 'wa_messages, nyo_messages, plugins, knowledge_docs', knowledge: ['wake-up-policy'], run_slug: 'nyo-wake-up' },

  // ── event-driven ──
  { name: 'WhatsApp inbound', kind: 'event', trigger: 'event · per inbound message (webhook)',
    steps: 'persist the message, identify the sender (embedded author → CRM contacts → live group roster), stitch to a person',
    touches: 'wa_messages, contacts, identities', knowledge: [] },
  { name: 'Outbox (unified send)', kind: 'event', trigger: 'event · per outbound send',
    steps: 'every send wrapper queues an outbox row → calls the provider → flips it sent (with message id) or failed (with error + a fail event) — the permanent audit trail',
    touches: 'outbound_log', knowledge: [] },

  // ── on-demand (operator / Nyo) ──
  // Pack workflows ship in their pack's manifest with their descriptions.
];

// ── Modules — the machine-readable product-area registry (mirrors the SPA
// sidebar; the page IS the module per nyyon-lite layer 4). area: module =
// day-to-day surface; system = operator plumbing.
// The static list is the HOST's own surfaces; installed plugins contribute
// their pages through the plugins registry, not here.
const MODULES = [
  { key: 'nyo',       title: 'Nyo',       area: 'module', description: 'AI command chat — the tool pool\'s operator interface, wake-up briefings, voice mode' },
  { key: 'plugins',   title: 'Plugins',   area: 'system', description: 'trade capabilities between nyyon systems — import/export signed manifests; code travels verbatim, gateways bind mechanically' },
  { key: 'knowledge', title: 'Knowledge', area: 'system', description: 'the editable rules layer — doc tree Nyo and the code read at runtime' },
  { key: 'activity',  title: 'Activity',  area: 'system', description: 'the event bus log — every mutation, live' },
  { key: 'expand-build', title: 'Expand build', area: 'system', description: 'where the source lives (the checkout IS the install) + the handoff prompt that briefs a coding agent on the layout and the five-layer rules; prompt body is the expand-build-prompt knowledge note' },
  { key: 'settings',  title: 'Settings',  area: 'system', description: 'theme, Nyo brain provider, sidebar module toggles' },
];

// ── Tool grouping (ordered — first match wins) + per-group knowledge deps ────
//
// These patterns match the v2 pool, which is verb_noun with NO family prefix:
// the old `/^gtm_/` and `/^outreach_/` anchors matched nothing after the split
// and would have dropped ~half the pool into "Other". ORDER IS LOAD-BEARING —
// each comment below names the collision the position resolves. Adding a tool
// whose name matches nothing here renders it ungrouped, not missing.
const TOOL_GROUPS = [
  // Pack tools land in "Other", honestly labeled as pool tools a pack provides.
  { group: 'WhatsApp',            re: /whatsapp|wa_chat|wa_group|wa_session|backfill_wa_messages|backfill_lid_map|read_group_participants|set_chat_listening/, knowledge: [] },
  { group: 'LinkedIn',            re: /linkedin/,                                          knowledge: [] },
  { group: 'Calendar & Reminders', re: /calendar|meeting|reminder/,                        knowledge: ['meeting-reminders'] },
  { group: 'Conversations',       re: /conversation/,                                      knowledge: [] },
  { group: 'Workflows',           re: /workflow/,                                          knowledge: [] },
  { group: 'Web',                 re: /web_page|deploy/,                    knowledge: [] },
  { group: 'Knowledge',           re: /knowledge|log_note|list_events|notify_operator/,    knowledge: [] },
  { group: 'System & Outbox',     re: /health|registry|restart|feature_flag|outbox|system|telegram|plugin/, knowledge: [] },
];

function groupOf(name) {
  for (const g of TOOL_GROUPS) if (g.re.test(name)) return g.group;
  return 'Other';
}

export async function buildRegistry(env) {
  // Live tools — dynamic import breaks the tools ↔ registry.js cycle.
  let toolDefs = [];
  try {
    const mod = await import('../tools/index.js');
    toolDefs = await mod.visibleToolDefs(env);
  } catch { /* tools registry unavailable — return the rest */ }

  const groupMap = new Map();
  for (const g of TOOL_GROUPS) groupMap.set(g.group, { group: g.group, knowledge: g.knowledge, tools: [] });
  groupMap.set('Other', { group: 'Other', knowledge: [], tools: [] });
  for (const d of toolDefs) {
    groupMap.get(groupOf(d.name)).tools.push({ name: d.name, description: d.description || '' });
  }
  const tools = [...groupMap.values()]
    .filter((g) => g.tools.length)
    .map((g) => ({ ...g, tools: g.tools.sort((a, b) => a.name.localeCompare(b.name)), count: g.tools.length }));

  // Gateways — the live code registry (one slug per external service) merged
  // with META. "configured?" comes from listGatewayStatus(), which resolves a
  // credential DB-first then env — so a gateway connected in the app reads as
  // configured here too. Still no live probe (health does that), so the
  // registry loads instantly and never burns a paid credit.
  const status = await listGatewayStatus(env).catch(() => ({ gateways: [] }));
  const statusBySlug = Object.fromEntries(status.gateways.map((s) => [s.slug, s]));
  const gateways = listGateways().map((g) => {
    const meta = GATEWAY_META[g.slug] || { kind: 'public-api', knowledge: [] };
    const st = statusBySlug[g.slug];
    return {
      name: g.slug,
      service: g.service,
      kind: meta.kind,
      ops: `${g.description} · modes: ${g.modes.join(' / ')}`,
      config: (st?.fields || []).map((f) => f.key),
      knowledge: meta.knowledge,
      configured: st ? st.configured : true,
      missing: st?.missing || [],
      // Where the credentials actually come from: 'db' (connected in the app),
      // 'env' (a Cloudflare secret / .dev.vars), or 'none' (nothing needed).
      source: st?.source || 'none',
    };
  });

  // Real last-run times per workflow_slug — every automated trigger now logs a
  // workflow_runs row, so the trail is live, not inferred.
  const lastRunBySlug = {};
  try {
    const r = await env.DB.prepare(
      'SELECT workflow_slug, MAX(COALESCE(finished_at, started_at)) AS t FROM workflow_runs GROUP BY workflow_slug',
    ).all();
    for (const row of r.results || []) lastRunBySlug[row.workflow_slug] = row.t;
  } catch { /* table may be absent */ }

  // Descriptive entries (real hardcoded pipelines) + the authored/runnable
  // workflows from D1 (skipping slugs a descriptive entry already covers).
  const described = WORKFLOWS.map(({ run_slug, ...w }) => ({
    ...w,
    last_run_at: run_slug ? (lastRunBySlug[run_slug] ?? null) : null,
  }));
  const coveredSlugs = new Set(WORKFLOWS.map((w) => w.run_slug).filter(Boolean));
  let authored = [];
  try {
    const rows = await listWorkflows(env);
    authored = rows
      .filter((w) => !coveredSlugs.has(w.slug) && w.status !== 'disabled')
      .map((w) => {
        const trig = w.trigger || {};
        const stepNames = (Array.isArray(w.steps) ? w.steps : [])
          .map((st) => (typeof st === 'string' ? st : st?.tool)).filter(Boolean);
        return {
          name: w.name || w.slug,
          kind: trig.kind === 'cron' ? 'automated' : trig.kind === 'event' ? 'event' : 'on-demand',
          trigger: `${w.source === 'system' ? 'system' : 'authored'} · run_workflow ${w.slug}`,
          steps: stepNames.length ? stepNames.join(' → ') : (w.description || 'observability-only (runs logged by code)'),
          touches: '',
          knowledge: [],
          last_run_at: lastRunBySlug[w.slug] ?? null,
        };
      });
  } catch { /* workflows table may be absent */ }
  const workflows = [...described, ...authored];

  return {
    gateways,
    tools,
    workflows,
    modules: MODULES,
    counts: {
      gateways: gateways.length,
      gateways_configured: gateways.filter((g) => g.configured).length,
      tools: toolDefs.length,
      tool_groups: tools.length,
      workflows: workflows.length,
      modules: MODULES.length,
    },
    generated_at: Date.now(),
  };
}
