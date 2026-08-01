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
  social:   { kind: 'saas',       knowledge: ['brand-voice', 'personal-voice'] },
  linkedin: { kind: 'tunnel',     knowledge: [] },
  image:    { kind: 'binding',    knowledge: [] },
  assets:   { kind: 'binding',    knowledge: [] },
  whatsapp: { kind: 'tunnel',     knowledge: ['prompt-wa-reply'] },
  deploy:   { kind: 'tunnel',     knowledge: [] },
  tts:      { kind: 'tunnel',     knowledge: ['nyo-voice'] },
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
  { name: 'Hourly awareness sweep', kind: 'automated', trigger: 'cron · :00 / :15 / :30',
    steps: 'OSINT scrape (targets untouched >3h, max 5/tick) at :00 → heartbeat scoring at :15 → regenerate the digest at :30 — one leg per invocation (each gets its own subrequest budget), digest still reads this hour\'s fresh signals',
    touches: 'osint_targets, osint_mentions, osint_signals, digest_items, digest_channels',
    knowledge: ['prompt-wa-reply', 'industry-pulse', 'heartbeat-priorities'], run_slug: 'hourly-awareness-sweep' },
  { name: 'Meeting reminders', kind: 'automated', trigger: 'cron · 0 * * * *',
    steps: 'scan calendar_events, WhatsApp the operator a reminder N minutes before a meeting (no-op until a reminder chat is set)',
    touches: 'calendar_events, wa (via outbox)', knowledge: [], run_slug: 'meeting-reminders' },
  { name: 'Daily AEO publish', kind: 'automated', trigger: 'cron · 0 6 * * *',
    steps: 'publish any AEO article whose interview is captured + scheduled straight to nyyon.com (readyOnly — never auto-interviews or nags, never double-posts)',
    touches: 'aeo_questions, blog_posts',
    knowledge: ['brand-voice', 'personal-voice', 'article-playbook', 'brand'], run_slug: 'aeo-daily-writer' },

  { name: 'Outreach queue tick', kind: 'automated', trigger: 'cron · :45 hourly',
    steps: 'walk the enrolments whose next message is due AND individually approved (while require_approval is on, an unapproved message is left where it is and never sent — it stays visible in the cohort sheet as a backlog) → re-read each conversation and drop anyone who replied (permanent) → apply the operator per-prospect edit if there is one → send, honouring the sending window, daily cap and minimum gap — DRY RUN unless the outreach.live feature flag is true',
    touches: 'outreach_cohort_members, wa_messages, outbound_log',
    knowledge: ['outreach-cohort-cadence'], run_slug: 'outreach-queue-tick' },

  { name: 'Hot Takes scheduler', kind: 'automated', trigger: 'cron · :00 hourly',
    steps: 'scan due scheduled releases → publish the website leg (blog pipeline — REAL, same trust as the Blog Approve button) + fire due LinkedIn legs (social gateway → outbox; DRY-RUN unless the hottakes.live feature flag is true — dry runs log hottake_dryrun events only)',
    touches: 'hot_take_packages, social_posts, blog_posts, outbound_log, calendar_events',
    knowledge: ['hottakes-timing'], run_slug: 'hottake-scheduler' },

  // ── continuous (client, while the app is open) ──
  { name: 'Nyo pending poller', kind: 'continuous', trigger: 'client · every 30s',
    steps: 'poll /api/nyo/pending, inject any queued Nyo message into the chat, mark it delivered',
    touches: 'nyo_messages', knowledge: [] },
  { name: 'Nyo wake-up', kind: 'continuous', trigger: 'client · on mount + tab focus',
    steps: 'pull WhatsApp from the gateway → survey pending / failed / missed publishes → queue a morning briefing (idempotent; skips if nothing changed)',
    touches: 'wa_messages, nyo_messages, aeo_questions', knowledge: [], run_slug: 'nyo-wake-up' },

  // ── event-driven ──
  { name: 'WhatsApp inbound', kind: 'event', trigger: 'event · per inbound message (webhook)',
    steps: 'persist the message, identify the sender (embedded author → CRM contacts → live group roster), stitch to a person',
    touches: 'wa_messages, contacts, identities', knowledge: [] },
  { name: 'Blog → Calendar mirror', kind: 'event', trigger: 'event · on blog publish',
    steps: 'on every post saved published=1, upsert a matching calendar_event (kind=blog_publish, done if past / confirmed if future)',
    touches: 'calendar_events', knowledge: [], run_slug: 'blog-to-calendar-mirror' },
  { name: 'Outbox (unified send)', kind: 'event', trigger: 'event · per outbound send',
    steps: 'every send wrapper queues an outbox row → calls the provider → flips it sent (with message id) or failed (with error + a fail event) — the permanent audit trail',
    touches: 'outbound_log', knowledge: [] },

  // ── on-demand (operator / Nyo) ──
  { name: 'Digest generate (headless)', kind: 'automated', trigger: 'cron · :30 hourly',
    steps: 'for each enabled channel: LLM-extract WhatsApp asks + judge OSINT mentions + surface calendar events → dedupe → digest_items. No page reads these any more — they are the raw material the Hot Takes topic feed scores',
    touches: 'digest_items, digest_channels', knowledge: ['prompt-wa-reply'], run_slug: 'hourly-awareness-sweep' },
  { name: 'Hot Takes first ingest', kind: 'on-demand', trigger: 'on-demand · the module first-run panel',
    steps: 'pull every enabled feed → score what came back → cluster it into hot topics (synthesis optional: a first pull can legitimately have too few scored signals to cluster). No scrape, no enrichment, no digest — the shortest path from "sources saved" to "the Topics tab has cards"',
    touches: 'osint_sources, osint_signals, osint_topics',
    knowledge: ['hottakes-source-scout', 'heartbeat-priorities'], run_slug: 'hottakes-first-ingest' },
  { name: 'GTM intake enrichment', kind: 'on-demand', trigger: 'on-demand · per lead (batch stepper)',
    steps: 'WhatsApp identity → company-from-LinkedIn → PDL → Twilio → Google → reconcile (provenance + conflicts kept)',
    touches: 'gtm_leads', knowledge: [] },
  { name: 'GTM outreach angles', kind: 'on-demand', trigger: 'on-demand · per green lead',
    steps: 'compose gtm-you + lev-positioning + gtm-outreach + the verified org → Opus → ranked angles with draft bubbles',
    touches: 'gtm_outreach_angles', knowledge: ['gtm-you', 'gtm-outreach', 'lev-positioning', 'brand-icp'] },
  { name: 'AEO interview & write', kind: 'on-demand', trigger: 'on-demand · Interview & Write button',
    steps: 'ask the 4 interview questions → draft the article in Nyyon voice → publish live + mirror to calendar',
    touches: 'aeo_questions, blog_posts, calendar_events', knowledge: ['brand-voice', 'article-playbook'] },
  { name: 'Sunday editorial brain', kind: 'on-demand', trigger: 'on-demand · Sunday (Nyo offers) / Brain start',
    steps: 'ask the weekly questions → derive the week\'s article slate → schedule each across the week + create calendar events',
    touches: 'brain_sessions, aeo_questions, calendar_events', knowledge: ['brand-voice'] },
  { name: 'Blog publish → prod', kind: 'on-demand', trigger: 'on-demand · Publish button / Nyo',
    steps: 'render the article + push it to nyyon.com through the publish sidecar, then mirror it to the calendar',
    touches: 'blog_posts, calendar_events', knowledge: [] },
];

// ── Modules — the machine-readable product-area registry (mirrors the SPA
// sidebar; the page IS the module per nyyon-lite layer 4). area: module =
// day-to-day surface; system = operator plumbing.
// Seven product modules + five pinned system pages. Everything cut in the
// productization strip (tasks, digest, outbox, website, funnel, channels, CRM,
// pipeline, the old GTM page, li-outreach, finance, aeo, calendar, osint, the
// workflows page) is gone from here because the PAGE is gone — several of their
// engines are still running headless (the AEO writer behind Blog, the OSINT +
// heartbeat + digest sweep behind the Hot Takes topic feed, the outbox behind
// every send, the calendar store behind reminders and publish mirrors).
const MODULES = [
  { key: 'nyo',       title: 'Nyo',       area: 'module', description: 'AI command chat — the tool pool\'s operator interface, wake-up briefings, voice mode' },
  { key: 'daily-planner', title: 'Daily Planner', area: 'module', description: 'planning workspace — a guided chat produces a persisted, editable day plan (schedule + to-dos); weekly objectives vs wing-it, history search, 3-day follow-ups' },
  { key: 'prospecting', title: 'Prospecting', area: 'module', description: 'list-first view over the lead store: List Enrichment (compact table, traffic-light rows, per-row Truecaller) → Verified Contacts (cards of green, identity-confident leads)' },
  { key: 'outreach',  title: 'Outreach',  area: 'module', description: 'approach the prospects Prospecting surfaced — Conversations (a WhatsApp inbox filtered to prospects, split active / unanswered / dead, each thread opening beside the prospect card with a suggested reply offered alongside) + Queue (who is enrolled in the automated ladder, what we last said, what goes next and when; a reply removes them from automation permanently)' },
  { key: 'blog',      title: 'Blog',      area: 'module', description: 'article drafts → review → publish (edge-rendered); the answer-engine writer + its daily cron run headless behind it' },
  { key: 'social',    title: 'Social',    area: 'module', description: 'per-channel social drafts → operator approve → Make webhooks' },
  { key: 'hot-takes', title: 'Hot Takes', area: 'module', description: 'editorial command center — topic → take → brief → article → review → social → schedule, one publication package; Publications tab carries the whole blog (any draft schedules into a release)' },
  { key: 'knowledge', title: 'Knowledge', area: 'system', description: 'the editable rules layer — doc tree Nyo and the code read at runtime' },
  { key: 'registry',  title: 'Registry',  area: 'system', description: 'this page — live map of gateways / tools / workflows / modules' },
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
  // Ahead of Prospecting because read_lead_angles belongs to the outreach
  // composer, not the enrichment chain. Note `due_messages` rather than a bare
  // `_messages$`: that would swallow WhatsApp's backfill_wa_messages.
  { group: 'Outreach',            re: /thread|cohort|_member|bubble|compose_reply|lead_angles|drafting_rules|sequence|cadence|step_copy|_message$|due_messages|_replies$|promotion_rules|schedule_send|scheduled_send|_sends$|send_outreach|approvals/, knowledge: ['outreach-reply-drafting', 'outreach-promotion', 'outreach-sentiment', 'gtm-outreach'] },
  // Before WhatsApp (lookup_wa_identity is an enrichment source, not a chat
  // tool) and before LinkedIn (lookup_company_from_linkedin likewise).
  { group: 'Prospecting',         re: /^read_lead$|^save_lead$|^promote_lead$|_identity$|_identities$|org_chart|company_profile|open_roles|_pdl$|_twilio$|socials_serp|score_icp|^draft_angles$|^save_angles$|green_leads|^read_you$|api_usage|api_limits|company_from_linkedin/, knowledge: ['gtm-outreach', 'gtm-you', 'brand-icp', 'lev-positioning'] },
  { group: 'WhatsApp',            re: /whatsapp|wa_chat|wa_group|wa_session|backfill_wa_messages|backfill_lid_map|read_group_participants|set_chat_listening/, knowledge: ['prompt-wa-reply'] },
  { group: 'LinkedIn',            re: /linkedin/,                                          knowledge: [] },
  { group: 'Digest',              re: /digest/,                                            knowledge: [] },
  // Before Editorial: link_hottake_article / scan_hottake_article would land in
  // the blog group on `_article$`.
  // `feed_url` is here on purpose: validate_feed_url is the module's proof that
  // a proposed source is real, so it belongs beside the sources it guards.
  { group: 'Hot Takes & Signals', re: /hottake|topic_feed|adopt_blog_draft|article_meta|heartbeat|feed_url|_signal$|_signals$|pulse|hot_topics|osint|mention/, knowledge: ['industry-pulse', 'heartbeat-priorities', 'hottakes-source-scout'] },
  { group: 'Editorial (Blog / AEO)', re: /blog_post|aeo_|voice_profile|_article$|faq_schema|_figures$|_cover$|featured_image|visual_brief|_images$|interview_|taste_profile|suggestion_policy|suggestion_angles/, knowledge: ['brand-voice', 'personal-voice', 'article-playbook', 'brand'] },
  { group: 'Social',              re: /social_post|social_integrations|social_card|_card$/, knowledge: ['brand-voice', 'personal-voice'] },
  { group: 'Daily Planner',       re: /daily_plan|recent_plans|weekly_objectives/,          knowledge: ['daily-planner-persona'] },
  { group: 'Calendar & Reminders', re: /calendar|meeting|reminder/,                        knowledge: ['meeting-reminders'] },
  { group: 'Conversations',       re: /conversation/,                                      knowledge: [] },
  { group: 'Workflows',           re: /workflow/,                                          knowledge: [] },
  { group: 'Web',                 re: /web_page|website|funnel|deploy/,                    knowledge: [] },
  { group: 'Knowledge',           re: /knowledge|log_note|list_events|notify_operator/,    knowledge: [] },
  { group: 'System & Outbox',     re: /health|registry|restart|feature_flag|outbox|system/, knowledge: [] },
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
