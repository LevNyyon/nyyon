// Nyo chat — Anthropic Messages with tool calling, streamed over SSE.
// One non-streaming model call per hop; we loop on tool_use until stop_reason='end_turn'.

import { visibleToolDefs, runTool } from '../tools/index.js';
import { uid, now } from '../lib/util.js';
import { classifyLlmError, noteLlmDown, noteLlmOk } from '../lib/llm.js';
import { llmTransportAnthropic, llmTransportOpenAICompat } from '../lib/openai.js';
import { loadModelConfig } from '../lib/model-config.js';
import { loadPlannerPersona } from '../lib/planner-persona.js';
import { loadDontSoundAi } from '../lib/dont-sound-ai.js';
import { deriveTitle } from '../lib/conversations.js';

// Tools the Daily Planner agent is cut off from — the plan is self-contained
// (its own daily_plans), NOT synced to the real calendar or task list for now.
// The deny-set is a plain Set of strings with no validation, so a name that no
// longer exists is INVISIBLE dead weight — every entry below is a live tool.
const PLANNER_DENY_TOOLS = new Set([
  'list_calendar_events', 'read_calendar_event', 'write_calendar_event', 'delete_calendar_event',
  // The reminder pipeline: get_/set_meeting_reminders are gone, and these are
  // the three verbs that replaced them. The planner stays cut off from all of it.
  'list_due_meetings', 'claim_due_meetings', 'compose_reminder',
]);

const SYSTEM = `You are Nyo, the chatbot at the center of the Nyyon Command Center.

The Command Center is an operator backstage hub. You sit at the center, surrounded by **modules** (the product areas in the sidebar: Digest, CRM, Pipeline, Prospecting, Blog, Social, Hot Takes, AEO, OSINT, Calendar, Website, Funnel…) and **tools** (your ~200 real capabilities across knowledge, planner, whatsapp, outreach, prospecting, blog/aeo, social, hot takes/signals, linkedin). Every tool is ONE verb on ONE noun; anything multi-step is a **workflow** — an ordered list of those tools that you run with run_workflow(slug). A handful of tools load up front; the rest load on demand. When you need a capability you don't currently see, call the tool-search tool (regex over tool names + descriptions, e.g. \`osint\`, \`whatsapp\`, \`linkedin\`, \`lead\`) to load it, then call it. Search proactively, never say a tool is missing without searching first. list_workflows shows every workflow you can run.

COMPOSE, don't stall. You have an agentic loop — call tools in SEQUENCE, feeding one tool's result into the next. Most requests are a CHAIN of primitives you already have (read/list → decide → write/create/act), NOT a single purpose-built tool. If no one tool matches the ask, ACHIEVE IT by chaining the tools you have, or by running the workflow that already chains them: e.g. "turn this social post into an article" = run_workflow('article-from-social', {id}); "write a post about X" = run_workflow('blog-shape', {title, body}); "add the post we wrote to Social" = save_social_post. Only conclude something is impossible after you have BOTH tool-searched AND checked list_workflows. Never ask the operator to do a step you could do by chaining, and never refuse just because there is no tool named exactly after the task.

Exploration discipline (important): reading and searching exist to gather ENOUGH, then act. Never repeat an identical read or search in one turn — once you have read a doc or run a search, you already have that result; re-running it is a bug, not progress (you'll get a cached copy flagged as a repeat). After roughly three exploration calls toward a single goal, STOP gathering and either do the task with what you have or ask the operator for the one specific thing you're missing. There is no perfect-information state; commit.

Target the RIGHT thing before you act. When the operator's reference is ambiguous — "the new blog post", "that item", "the last one" — and more than one candidate fits, do NOT guess by recency and start editing. List the candidates, pick the one the operator was most plausibly working on, and if still unsure name your pick in ONE line and proceed, or ask which. Editing/publishing the wrong record is far more costly than a one-line check. (In the reviewed run, "the new blog post" was taken as the newest-by-date and the wrong post got edited + published.)

NEVER REPORT WORK YOU DID NOT DO. Describing an action is not performing it. If you say "I'll create it", "draft saved", "cleared", "sent", or "done", the matching tool call MUST have actually run in that same turn AND returned success — otherwise you are lying to the operator. Specifically: (a) never write out a tool call in prose as though it executed; emit the real call. (b) Never invent an id, slug, or filename and then speak about it as if the record exists — list/read first and use a REAL id (a guessed id like dg_0001 is how a "cleanup" silently cleared nothing). (c) Never quote, summarize, or render the contents of a record you did not actually read back from a tool result; if you drafted prose in your head, it is a proposal, not a saved artifact — say so. (d) If a tool errored or you skipped it, state that plainly instead of narrating success. A caught failure reported honestly is fine; a fabricated success destroys trust and the operator finds out later when the thing is missing. This has really happened: an article was reported "saved as a draft in your Blog module" with a slug and a full body, and nothing had been written at all.

Failure discipline — do NOT thrash. If a tool returns the SAME error twice, stop calling it: the backend is broken, not your arguments. Report plainly what you tried, the exact error, and what it implies (e.g. "image generation is down: missing API key + a code bug"), then either route through a DIFFERENT working path or tell the operator it needs a fix — never loop the same failing call with tweaked params hoping it catches. Retrying a structurally-broken tool 4+ times wastes the operator's time and trust.

How you work:
- Look at the data before answering. For any system-design / module / tool / definition question, first call list_knowledge then read_knowledge for the right slug. Don't recite from memory if a knowledge doc exists.
- When the operator makes a decision, names a new module, or captures a definition — persist it via write_knowledge so future sessions inherit it. Slugs are lowercase-with-dashes and stable (never rename — write a new doc and link).
- When asked "what changed" / "what happened today": call list_events.
- The **live registry** (call read_registry, or the Registry page in the sidebar) is the source of truth for what actually exists: every external gateway + its status, your real tools grouped by domain, the scheduled workflows, and the knowledge doc each depends on. It is derived from the running code — there is nothing to hand-maintain, so trust it over memory when the operator asks "what can you do / what's connected".
- BEFORE adding any new module — call read_knowledge with slug "how-to-add-a-module" and follow the 8-step checklist. Missing a step means the module is invisible or broken. If the operator asks you to add a module and you skip the doc, you are not doing the job.
- BEFORE any WhatsApp work — call read_knowledge with slug "whatsapp-endpoints". Always use send_whatsapp / send_whatsapp_image / send_whatsapp_document / react_whatsapp. These tools auto-prime the session (probe → /start → poll until ready) and persist outbound rows in wa_messages with from_me=1 so echoes dedup. Never hit wa-gateway directly; the wrappers handle the puppet wake-up sequence the operator just baked in.
- To resolve a WhatsApp contact the operator names ("I met David Kogan", "did I message Sarah"), use find_wa_chat — it fuzzy-matches (token-based, case-insensitive) across chat names, sender pushnames, AND CRM names-by-phone. Do NOT scan list_wa_chats to find a person: 1:1 DMs usually have no stored chat name. If find_wa_chat returns nothing, the name simply isn't in the stored WhatsApp data or the CRM yet — say so plainly, ask for a phone number, and offer to add them to the CRM. You can always do the CRM/meeting work from the operator's summary without the WhatsApp thread.
- For thoughts the operator wants timestamped without bloating a doc, log_note is the right tool.
- Feature flags gate tools and UI surfaces. If a tool errors "disabled by feature flag", surface that — don't try to bypass.

Editorial / blog loop — you OWN getting articles WRITTEN AND LIVE, not just queued. A "post" means live on the operator's public site, never a row sitting in a queue. The writing chains are WORKFLOWS; you run them with run_workflow(slug, input).
- Write a post from scratch or reshape one: run_workflow('blog-shape', {title, body}) — add {slug} to rewrite an existing post in place. Lengthen one with an FAQ: run_workflow('blog-expand', {slug}). Turn a social post into an article: run_workflow('article-from-social', {id}).
- Per-article interview: for a pending question with no interview yet, run_workflow('aeo-interview-start', {question_slug}), ask the 4 saved questions, and the MOMENT the operator answers, run_workflow('aeo-write-with-answers', {question_slug, answers}). Never collect interview answers and stop — an answered interview MUST end as a published post. If you ask and they answer, you write.
- To write a question whose interview is already captured: run_workflow('aeo-write', {question_slug}) — or with no input to take the next due ready question. It REFUSES a question with no answers (that is the interview gate, not an error to retry): start the interview instead.
- Every writing workflow ends at a DRAFT. Publishing is the operator's own action: call publish_blog_post(slug) after they say ship, and confirm the live public-site URL. Visuals: run_workflow('article-figures'|'blog-cover'|'blog-featured-image', {slug}).

Writing & editing copy — write IN the operator's voice, don't sanitize around it. Before you draft OR edit any post/article/outreach copy, read the governing docs: the personal-voice doc for the operator's personal LinkedIn, the brand-voice doc for company channels, and writing-style-rules for the hard constraints + banned-phrase list. Then WRITE in that voice — its personality, wit, rhythm, edge — not a neutral version of it. Surgical phrase-swapping is NOT "using the voice": if the operator says "use my voice" or "you castrated the humor," re-read the voice doc and rewrite the whole piece from it, don't just tweak the flagged words. When the operator bans a phrase, add the entire FAMILY (the construction + its variants) to writing-style-rules AND, in the SAME turn, rewrite every current draft that violates it — never announce a violation and ask whether to fix it.

Deliver, don't ask. When the operator points at a problem ("this line is banned", "fix it", "look at my post", "rewrite it"), FIX IT FULLY in that turn and show the result — do NOT ask them for the replacement line, and do NOT end with a menu of next steps ("Want me to tighten X? What's next?"). They flagged it because they want it handled; handle it. Ask a question ONLY when you genuinely cannot proceed without a decision that is theirs alone to make. Trailing "want me to…?" offers after every action are noise — state what you did and stop, or do the obvious next step.

Publishing to social: there is NO direct post tool, on purpose — every send takes the outbox claim. To queue a post for the operator to approve, call save_social_post({channel, content, image_url}). To publish one the operator has explicitly confirmed (text, image AND channel), run_workflow('social-post-now', {channel, content, image_url, title}) — save → approve → push under one claim; cross-posting is one run per connection. To release something already in the queue, run_workflow('social-release-post', {id}). To draft the three channel posts for an article, run_workflow('social-drafts-for-article', {slug}). Call list_social_integrations first to see the connections: "linkedin-company" (the company page, the default for LinkedIn), "linkedin-personal" (the operator's personal profile), "facebook-company" (the company Facebook page). Do NOT use post_linkedin_text to publish — it bypasses the approve queue; every post goes through the outbox claim above. The LinkedIn tools (read_linkedin_profile, get_linkedin_feed, list_linkedin_dms, send_linkedin_dm, search_linkedin_people, send_linkedin_connection) run through the Unipile gateway and are for reads / DMs / connections, not posting.

Tool truth — act on what tools RETURN, never on assumption. Never say you sent, posted, published, or deployed anything unless the tool returned a result confirming it. If you did not call the tool, or it errored / timed out / returned posted:false or verified:false, say so plainly ("I have NOT confirmed it posted") and then verify or retry — do not guess. For post_linkedin_text trust ONLY its returned fields and the Outbox row, never your own belief that it went out. When you finish an action, report the actual returned result (id / url / ok), not a paraphrase of intent.

CRM + pipeline — clients = companies (status active/past/prospect/partner, each with a pipeline stage + deal_value/mrr_value); contacts = people linked to a client. YOU HAVE NO CRM TOOLS in this build: browsing, editing and deleting clients/contacts happen in the CRM and Pipeline pages, not through you. Say so plainly and point the operator at the page rather than inventing a tool or guessing at counts. The one CRM action you DO own is promote_lead({id}), which puts a qualified prospect on the board as a linked contact + client at stage 'target' (idempotent). Prospect-side questions ("who did I contact", "who replied", "who is still untouched") are answered by list_green_leads, which carries each prospect's contact status.

Prospecting — the outreach pipeline (full runbook: read_knowledge slug "module-gtm"). The chains are WORKFLOWS; the pieces are granular tools.
- Identify one prospect: run_workflow('enrich-lead', {id}) — WhatsApp identity, company-from-LinkedIn, PDL, Twilio, SERP, org chart, then one reconcile + one save. Sources self-skip and a dead source is recorded, never fatal. A lead goes GREEN when first+last name + company + linkedin + position are all present; list_green_leads is the green list.
- Company facts: run_workflow('company-context', {id}) — org chart (pass {theorg_slug} to fix a namesake; org_status 'warn' BLOCKS outreach), LinkedIn headcount and open roles, cached on the lead. Qualify against the editable brand-icp doc: run_workflow('qualify-lead', {id}) — run company-context FIRST so the verdict is grounded in real data.
- Draft outreach: run_workflow('draft-outreach-angles', {id}) writes ranked WhatsApp bubbles from the gtm-you + gtm-outreach docs. Editing those docs changes how outreach is written — they are the control surface, point the operator at them. It DRAFTS only.
- send_outreach({id, bubbles}) actually MESSAGES the prospect (paced, logged): show the exact bubbles and get an explicit yes first, every time. schedule_send does the same at a future time — same rule.
- Reads and repairs: read_lead({id}) is where every prospecting chain starts. audit_identities reports mismatches and is REPORT-ONLY; fix each one with run_workflow('clean-identity', {id}), one run per lead. The operator profile driving outreach voice/warm paths is the gtm-you doc (read_you to read, write_knowledge to edit).

Tone: terse, direct, plain. No marketing voice. No emoji. No filler ("Sure!", "Of course!"). When the operator asks a question, answer it; when they describe a decision, capture it.`;

// Speech mode — the operator flipped the chat to voice. Nyo's reply gets read
// aloud (Piper TTS), so it must be ULTRA short and operational. Appended as a
// second system block (after the cached SYSTEM prefix) only when speech is on.
const SPEECH_SYSTEM = `SPEECH MODE IS ON — the operator is LISTENING, not reading, and every reply is spoken aloud. Answer in the FEWEST words possible: all signal, no noise. One or two short sentences, aim for under 25 words. No preamble, no lists, no markdown, no headings, no emoji, no restating the question. Lead with the answer / the number / the status, then stop. Add detail ONLY if the operator explicitly asks for it. This is a quick operational back-and-forth, not an essay.`;

// Lean system prompt for the LOW tier (a fast small API model). The full SYSTEM above
// (~thousands of tokens, written for Claude + ~130 tools) overwhelms a 3B: prompt
// eval alone can blow the 60s hop budget, and the model gets lost. This is scoped
// to exactly the LOW_TOOLS set and keeps the model fast + on-task.
const LOW_SYSTEM = `You are Nyo, the operator's assistant in the Nyyon Command Center, running on the install's small fast model. Be terse and direct — plain answers, no filler, no marketing voice, no emoji.

You have a SMALL tool set. Use a tool ONLY when the question needs live data or an action; otherwise just answer from what you know.
- Knowledge / awareness: list_knowledge, read_knowledge, read_knowledge_path (the operator's docs); list_events (what changed recently).
- WhatsApp: list_wa_chats (recent chats + last message), find_wa_chat (find a person by name), list_wa_groups, read_group_participants, send_whatsapp / send_whatsapp_image / send_whatsapp_document, react_whatsapp.
- Diagnostics: check_health, probe_linkedin, restart_wa_session.

Discipline: never repeat a tool call within a turn. After at most one or two tool calls, STOP and answer with what you have. If the request needs a capability NOT in the list above (blog, GTM, CRM, social, AEO, deploys, the Sunday Brain / brain dump / editorial planning, etc.), don't guess and don't call knowledge tools hunting for it — say it's not available on Low and suggest switching to Mid or High. Answer exactly what was asked, nothing more.`;

// Bounded wait so a wedged tool or provider call can never hang the SSE stream
// (and thus Nyo) forever — it rejects, the loop records the error, and the turn
// still completes with 'done' instead of leaving the operator staring at "…".
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
const TOOL_TIMEOUT_MS = 35_000;   // any single tool call
// Generation & deploy pipelines run the writer LLM (house-style HTML + cover +
// diagrams) or build/deploy the site — ~60-90s, well past the default. Without a
// longer budget the chat loop false-times-out at 35s, Nyo sees an error, retries,
// times out again, and gives up mid-write ("couldn't expand into an article").
const SLOW_TOOLS = new Set([
  // run_workflow is the big one: a single call can be the whole article
  // pipeline (write → save → figures → cover), so it needs the long budget
  // even though it is one tool call from the model's side.
  'run_workflow',
  // the writer LLM
  'draft_article', 'expand_article', 'append_faq_schema',
  // publish + edge verify + rebuild
  'publish_blog_post',
  // figure + image pipelines: N candidates (+ optional vision judge) ~30-90s
  'draft_figures', 'render_figures', 'embed_figures',
  'draft_visual_brief', 'render_images', 'judge_images',
  'draft_cover', 'render_cover', 'draft_card', 'render_card',
  // the per-channel social writer
  'draft_social_post',
  // the awareness sweep's heavy legs
  'scrape_osint_targets', 'ingest_signals', 'enrich_signals',
  'synthesize_pulse', 'synthesize_hot_topics', 'generate_digest',
  // Hot Takes reasoning steps
  'draft_hottake_take', 'build_hottake_brief', 'scan_hottake_article',
]);
const SLOW_TOOL_TIMEOUT_MS = 150_000;   // writer/deploy pipelines

// ─── claim-vs-action guard ────────────────────────────────────────────────
// Nyo has narrated writes it never executed ("Draft is written and saved…"
// with no save_blog_post call at all). Prompt rules reduce that; this is the
// mechanical backstop. If the final assistant text of a turn claims completed
// work but NO mutating tool ran successfully in the whole turn, the loop
// injects a correction demand and gives the model one extra hop to either
// actually run the tool or restate honestly that nothing was done.
const CLAIM_RE = /(draft (is|was) (written|saved)|saved (as a draft|in your|to your)|is (saved|live|published|created)|נשמר|פורסם|נוצר(?:ה)? בהצלחה|has been (created|saved|sent|published|scheduled)|successfully (created|saved|sent|published|scheduled)|i('| ha)ve (created|saved|sent|published|scheduled)|(email|message|dm|post|draft|invite) (sent|created)|sent (it|the (message|email|dm))|marked (as )?(read|done)|cleared (them|all|the))/i;
// Read-only prefixes: a tool that starts with one of these never mutates. The
// v2 pool is verb-first, so the prefixes ARE the classification — fetch_/probe_/
// check_/audit_ are the pure readers the old hand-listed names covered.
const READONLY_PREFIX = /^(list_|read_|get_|find_|search_|fetch_|probe_|check_|audit_|tool_search)/;
const isMutatingTool = (name) => !READONLY_PREFIX.test(String(name || ''));

const LLM_TIMEOUT_MS  = 60_000;   // any single provider hop
const LOCAL_LLM_TIMEOUT_MS = 120_000; // local model (Low) — allow for a cold model load

export async function handleChat(env, { messages, conversation_id, tier, speech = false, agent = null }) {
  // Credentials are DB-first (Settings stores them in gateway_config; env is
  // only the fallback). Every check below that reads env.ANTHROPIC_API_KEY
  // raw was blind to a key pasted through the product's own UI — a fresh
  // install with a verified key was told 'no model is connected'.
  const { withResolvedCredentials } = await import('../lib/gateway-config.js');
  env = await withResolvedCredentials(env);
  // Low / Mid / High model switch (sent per message; changeable mid-conversation).
  // Models resolve doc > env > default (the llm-models knowledge doc / Settings).
  const mc = await loadModelConfig(env).catch(() => null);
  const { pickBackupLlm } = await import('../gateways/index.js');
  const backupSlug = await pickBackupLlm(env);
  let cfg = resolveTier(env, tier, mc, backupSlug);
  // Low tier with nothing to run it (no backup plugin, no self-hosted
  // endpoint) is a preference, not a fatal state — a stale 'low' in one
  // browser was answering a bare 500 on an install with a perfectly good
  // Anthropic key. Upgrade the turn transparently.
  if (cfg.tier === 'low' && !cfg.gatewaySlug && !cfg.baseUrl && env.ANTHROPIC_API_KEY) {
    cfg = resolveTier(env, 'mid', mc, backupSlug);
  }
  const keyMissing =
    (cfg.provider === 'anthropic' && !env.ANTHROPIC_API_KEY) ||
    (cfg.provider === 'openai'    && !cfg.apiKey && !cfg.gatewaySlug);
  if (keyMissing) {
    // No main model key. If a backup-brain plugin is installed, an install
    // with no key is still a working install — that is the entire point of it.
    const backup = backupSlug ? resolveTier(env, 'low', mc, backupSlug) : null;
    if (!backup) {
      return new Response(JSON.stringify({ error: 'No model is connected. Add an Anthropic key in Settings — nothing that needs a model can run without one.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    cfg = backup;
  }

  const convId = conversation_id || uid();
  const lastUser = messages[messages.length - 1];
  await ensureConversation(env, convId, lastUser?.role === 'user' ? lastUser.content : '', agent);
  if (lastUser?.role === 'user') {
    await persistMessage(env, convId, 'user', lastUser.content);
  }

  // Daily Planner is Nyo's planning-desk persona — same tools + loop, a
  // different system prompt sourced from the editable `daily-planner-persona`
  // knowledge note. Any other agent (or none) keeps the default Nyo persona.
  let personaSystem = agent === 'daily-planner' ? await loadPlannerPersona(env) : null;
  // Every composition carries the don't-sound-AI rules — welded into the
  // system prompt here, the one choke point all personas pass through, so no
  // persona doc's wording can drop them. The doc itself is editable knowledge.
  const styleRules = await loadDontSoundAi(env);
  const styleWeld = styleRules
    ? `\n\n## Don't sound AI (hard rules — override any conflicting style above)\n\n${styleRules}`
    : '';
  if (personaSystem && styleWeld) personaSystem = personaSystem + styleWeld;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event, data) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  (async () => {
    try {
      let convo = messages.map(({ role, content }) => ({ role, content }));
      const allTools = await visibleToolDefs(env);
      // Low (local Qwen) gets a curated allow-list (WhatsApp + diagnostics +
      // knowledge): a 3B picks badly from 121, and the tool-search deferral trick
      // is Claude-only. Mid/High get the full deferred set.
      let activeCfg = cfg;
      let tools = cfg.toolAllow ? allTools.filter((t) => cfg.toolAllow.has(t.name)) : allTools;
      // Daily Planner is disconnected from the calendar + task list for now.
      if (agent === 'daily-planner') tools = tools.filter((t) => !PLANNER_DENY_TOOLS.has(t.name));
      // On the free tier every hop resends everything and the budget is
      // ~8K tokens/minute — WhatsApp and diagnostics defs are dead weight in a
      // planning conversation and their absence halves the burn per hop.
      if (cfg.gatewaySlug && agent === 'daily-planner') {
        const essentials = new Set(['read_daily_plan', 'save_daily_plan', 'update_daily_plan', 'search_daily_plans',
          'list_recent_plans', 'read_weekly_objectives', 'set_weekly_objectives', 'list_knowledge', 'read_knowledge']);
        tools = tools.filter((t) => essentials.has(t.name));
      }
      let fellBack = false;   // true once we've swapped mid/high → local this turn
      let notedOk  = false;   // close the credit circuit at most once per turn
      send('start', { conversation_id: convId, tier: cfg.tier, model: cfg.model || 'free backup model', tools: tools.map((t) => t.name) });

      // Per-turn dedup: an identical tool call (same name + inputs) returns the
      // cached result instead of re-running. Kills the "read the same doc / run
      // the same search in circles, never commit" loop.
      const toolCache = new Map();
      let mutationSucceeded = false;   // any mutating tool returned OK this turn
      let claimGuardFired = false;     // the claim-vs-action guard runs at most once

      let throttleWaits = 0;   // free-tier TPM absorbed silently, at most twice a turn
      let flubRetries = 0;     // free-model mangled tool calls resampled, at most twice a turn
      for (let hop = 0; hop < 8; hop++) {
        const res = await callLLM(env, convo, tools, activeCfg, speech, personaSystem, styleWeld);
        if (!res.ok) {
          let errText = await res.text();
          // Error bodies arrive as JSON envelopes; surface the MESSAGE, not
          // the wrapper — the envelope hid the 'free model:' label from every
          // downstream match and the operator got a raw blob.
          try { const j = JSON.parse(errText); errText = String(j?.error?.message || j?.message || errText); } catch { /* already plain */ }
          // Small models sometimes emit a tool call that fails validation
          // (dropped underscores, wrong arg shape). That is a dice roll, not a
          // condition — roll again instead of reporting it.
          if (activeCfg.gatewaySlug && /tool.?call validation|tool_use_failed|did not match schema/i.test(errText) && flubRetries < 2) {
            flubRetries++;
            hop--;
            continue;
          }
          // The free tier throttles per minute, and a multi-hop turn is exactly
          // what trips it. A short "try again in Ns" is absorbed here — the
          // operator sees a pause, not an error about a working model.
          if (activeCfg.gatewaySlug && res.status === 429 && throttleWaits < 2) {
            const m = errText.match(/try again in ([0-9.]+)\s*(ms|s)/i);
            const waitS = m ? (m[2].toLowerCase() === 'ms' ? Number(m[1]) / 1000 : Number(m[1])) : NaN;
            if (Number.isFinite(waitS) && waitS <= 12) {
              throttleWaits++;
              await new Promise((r) => setTimeout(r, Math.ceil(waitS * 1000) + 500));
              hop--;
              continue;
            }
          }
          const cls = activeCfg.provider === 'anthropic' ? classifyLlmError(res.status, errText) : null;
          // Main model out of credit / key rejected → open the circuit + fall
          // back to the local model ONCE for the rest of this turn.
          if (cls && !fellBack) {
            await noteLlmDown(env, cls, errText);
            const low = resolveTier(env, 'low', mc, backupSlug);
            if (low.gatewaySlug || (low.baseUrl && low.apiKey)) {
              fellBack = true;
              activeCfg = low;
              tools = allTools.filter((t) => low.toolAllow.has(t.name));
              await send('delta', { text: `\n\n_(The main model is unavailable, so this is running on the free backup model. Replies will be simpler until the main model is back.)_\n\n` });
              continue;
            }
          }
          await send('error', { message: errText.slice(0, 800) });
          break;
        }
        if (activeCfg.provider === 'anthropic' && !notedOk) { notedOk = true; await noteLlmOk(env); }
        const data = await res.json();

        for (const block of (data.content || [])) {
          if (block.type === 'text') {
            await send('delta', { text: block.text });
          } else if (block.type === 'tool_use') {
            await send('tool_call', { name: block.name, input: block.input });
          }
        }

        await persistMessage(env, convId, 'assistant', JSON.stringify(data.content || []));

        // The server-side tool search runs inline; if its loop pauses, push the
        // partial turn and let the server resume (no client tool_result to add).
        if (data.stop_reason === 'pause_turn') { convo.push({ role: 'assistant', content: data.content }); continue; }
        if (data.stop_reason !== 'tool_use') {
          // Turn is ending. If the closing text claims completed work but no
          // mutating tool succeeded anywhere in this turn, force one
          // correction hop instead of letting the fabricated success stand.
          const finalText = (data.content || []).filter((x) => x.type === 'text').map((x) => x.text || '').join(' ');
          if (!mutationSucceeded && !claimGuardFired && CLAIM_RE.test(finalText)) {
            claimGuardFired = true;   // one shot — never loop on our own guard
            convo.push({ role: 'assistant', content: data.content });
            convo.push({ role: 'user', content: [{ type: 'text', text: '[SYSTEM CHECK] Your last message claims completed work, but no mutating tool call succeeded in this turn — so nothing was actually saved, sent, or changed. Either run the real tool call NOW to do the work, or correct your message to state plainly that nothing was executed. Do not repeat the success claim without a successful tool result.' }] });
            await send('delta', { text: '\n\n_⚠ verifying that claim against actual tool activity…_\n\n' });
            continue;
          }
          break;
        }

        convo.push({ role: 'assistant', content: data.content });

        const toolResults = [];
        for (const block of (data.content || [])) {
          if (block.type !== 'tool_use') continue;
          let result;
          const dupKey = `${block.name}:${JSON.stringify(block.input ?? {})}`;
          if (toolCache.has(dupKey)) {
            // Already ran this exact call this turn — hand back the cached result
            // with a flag so the model stops re-fetching and commits.
            const cached = toolCache.get(dupKey);
            result = (cached && typeof cached === 'object' && !Array.isArray(cached))
              ? { ...cached, _repeat_note: 'You already ran this exact tool call in this turn. This is the cached result. Do not read or search it again; use it and proceed to answer or write.' }
              : cached;
            await send('tool_result', { name: block.name, ok: true, result, cached: true });
          } else {
            try {
              const slow = SLOW_TOOLS.has(block.name);
              const budget = slow ? SLOW_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS;
              // Slow generation/deploy tools stream nothing for ~1 min; without a
              // keep-alive the idle SSE connection can be dropped by the edge and
              // the operator sees a dead screen ("did nothing"). Tell them it's
              // working and ping every 20s to hold the stream open.
              let hb = null;
              if (slow) {
                await send('delta', { text: `\n\n_⏳ Running ${block.name.replace(/_/g, ' ')} — this pipeline takes ~1 min, hang tight…_\n\n` });
                hb = setInterval(() => { writer.write(enc.encode(': ping\n\n')).catch(() => {}); }, 20_000);
              }
              try {
                result = await withTimeout(runTool(env, block.name, block.input, { conversation_id: convId }), budget, block.name);
              } finally {
                if (hb) clearInterval(hb);
              }
              toolCache.set(dupKey, result);   // cache successes for dedup
              if (isMutatingTool(block.name)) mutationSucceeded = true;
              await send('tool_result', { name: block.name, ok: true, result });
            } catch (e) {
              result = { error: String(e?.message || e) };
              await send('tool_result', { name: block.name, ok: false, error: result.error });
            }
          }
          await persistMessage(env, convId, 'tool', JSON.stringify(result), { tool_name: block.name, tool_input: block.input });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
        if (!toolResults.length) break;  // only server tools ran this hop — nothing to return
        convo.push({ role: 'user', content: toolResults });
      }

      await send('done', { conversation_id: convId });
    } catch (e) {
      await send('error', { message: String(e?.message || e) });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ─── provider dispatch ──────────────────────────────────────
// Tiny abstraction so we can swap Anthropic out later. Every provider must
// return a Response whose JSON body matches the Anthropic Messages shape
// (stop_reason, content[]) — that way the tool-use loop above doesn't care.
// The operator's Low / Mid / High switch. Each tier resolves to a provider +
// model; the tier is sent per message so it can change mid-conversation. Because
// the loop keeps history in Anthropic shape and callOpenAI adapts both ways,
// switching tiers between turns is seamless. Models are env-overridable.
//   low  → a fast small API model (Haiku), curated tool
//          set (LOW_TOOLS: WhatsApp + diagnostics + knowledge).
//   mid  → Claude Sonnet.    high → Claude Opus.
function resolveTier(env, tier, mc = null, backupSlug = null) {
  const t = String(tier || 'mid').toLowerCase();
  if (t === 'low') {
    // An installed backup-brain plugin wins: it carries its own key and its own
    // model choice, so the host neither stores nor names either. A self-hosted
    // OpenAI-compatible endpoint stays supported for anyone who has one.
    if (backupSlug) {
      return {
        tier: 'low', provider: 'openai',
        gatewaySlug: backupSlug,
        model: null,                // the plugin picks: it knows what it connected to
        tokenParam: 'max_tokens',
        toolAllow: LOW_TOOLS,
      };
    }
    return {
      tier: 'low', provider: 'openai',
      model:   mc?.nyo_low || env.NYO_MODEL_LOW || 'claude-haiku-4-5',
      baseUrl: (env.OLLAMA_BASE_URL || '').replace(/\/+$/, ''),
      apiKey:  env.OLLAMA_API_KEY,
      tokenParam: 'max_tokens',   // an OpenAI shim wants max_tokens, not max_completion_tokens
      toolAllow: LOW_TOOLS,
    };
  }
  if (t === 'high') return { tier: 'high', provider: 'anthropic', model: mc?.nyo_high || env.NYO_MODEL_HIGH || 'claude-opus-4-8' };
  return { tier: 'mid', provider: 'anthropic', model: mc?.nyo_mid || env.NYO_MODEL_MID || 'claude-sonnet-5' };
}

async function callLLM(env, messages, tools, cfg, speech = false, personaSystem = null, styleWeld = '') {
  if (cfg.provider === 'anthropic') return callAnthropic(env, messages, tools, cfg, speech, personaSystem, styleWeld);
  if (cfg.provider === 'openai')    return callOpenAI(env, messages, tools, cfg, speech, personaSystem, styleWeld);
  return new Response(`Unknown provider: ${cfg.provider}`, { status: 500 });
}

// Tools that load up front (Nyo's bread-and-butter — used on almost every turn).
// Everything else is deferred and discovered via the server-side tool-search tool.
// Nyo carries ~200 tools; sending them all every turn blew past the org's ITPM
// limit. Deferred tools are NOT counted toward input tokens until the model
// searches for them, so a turn's input drops from ~30k to a few k.
const HOT_TOOLS = new Set([
  'list_knowledge', 'read_knowledge', 'read_knowledge_path', 'list_events',
]);

// Low (local Qwen) can't use Claude's deferred tool-search, so it gets a fixed,
// hand-picked set sized for a 3B: the everyday operator basics — WhatsApp
// (read + reply) and diagnostics (is-everything-up) — plus knowledge lookups.
// Everything heavier (blog/AEO/OSINT/LinkedIn/CRM writes) is Mid/High territory.
const LOW_TOOLS = new Set([
  // knowledge / awareness
  'list_knowledge', 'read_knowledge', 'read_knowledge_path', 'list_events',
  // WhatsApp — the basic day-to-day: read chats (list_wa_chats returns each
  // chat's last message snippet — the "latest messages" view), find a person, reply.
  // Deliberately NO backfill_wa_messages here: it's a slow wa-gateway history sync a
  // 3B kept mis-picking for simple "show me messages" reads. It's a Mid/High recovery op.
  'list_wa_chats', 'find_wa_chat', 'list_wa_groups', 'read_group_participants',
  'send_whatsapp', 'send_whatsapp_image', 'send_whatsapp_document', 'react_whatsapp',
  // diagnostics — "is everything up?" + recovery
  'check_health', 'probe_linkedin', 'restart_wa_session',
  // Daily Planner — the whole pack. When the main model is down, planning is
  // exactly the daily work an install must not lose, and these tools are
  // small, schema'd CRUD a local model handles fine.
  'read_daily_plan', 'save_daily_plan', 'update_daily_plan', 'search_daily_plans',
  'list_recent_plans', 'read_weekly_objectives', 'set_weekly_objectives',
]);

const TOOL_SEARCH = { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' };

async function callAnthropic(env, messages, tools, cfg, speech = false, personaSystem = null, styleWeld = '') {
  // Model comes from the Low/Mid/High switch (mid → Sonnet, high → Opus). Chat is
  // multi-hop and bursty; Sonnet's higher per-tier ITPM absorbs the hop loop, so
  // it's the default (mid) tier. Both are env-overridable (NYO_MODEL_MID/HIGH).
  const model = cfg?.model || env.NYO_MODEL_MID || 'claude-sonnet-5'; // callers pass cfg from resolveTier(env, tier, mc)
  // Search tool first (never deferred); hot tools load up front; defer the rest.
  // cache_control stays on `system` (NOT on a tool — a deferred tool with
  // cache_control is a 400).
  const toolPayload = [
    TOOL_SEARCH,
    ...tools.map((t) => (HOT_TOOLS.has(t.name) ? t : { ...t, defer_loading: true })),
  ];
  // Cache the static prefix (tools render first, then system; one breakpoint on
  // the last system block caches BOTH). Nyo ships ~30k tokens of tool schemas +
  // system every turn — cache_read tokens do NOT count toward the ITPM rate
  // limit, so on a warm cache a turn costs a few hundred ITPM instead of ~30k,
  // and ~90% less in $$. 5-min TTL; interactive turns stay warm.
  // Transport lives in the llm gateway (lib/openai.js) — chat only builds payloads.
  return llmTransportAnthropic(env, {
    model,
    max_tokens: 4096,
    system: speech
      ? [{ type: 'text', text: personaSystem || (SYSTEM + (styleWeld || '')), cache_control: { type: 'ephemeral' } }, { type: 'text', text: SPEECH_SYSTEM }]
      : [{ type: 'text', text: personaSystem || (SYSTEM + (styleWeld || '')), cache_control: { type: 'ephemeral' } }],
    tools: toolPayload,
    messages,
  }, { timeoutMs: LLM_TIMEOUT_MS });
}

// OpenAI chat-completions wrapper. Translates request shape on the way in
// (tools[] format differs) and response shape on the way out (tool_calls →
// tool_use blocks, finish_reason → stop_reason) so the loop sees Anthropic
// shape no matter which provider answered.
async function callOpenAI(env, messages, tools, cfg = {}, speech = false, personaSystem = null) {
  // Works for any OpenAI-compatible endpoint. For tier 'low' the cfg points at the
  // an optional self-hosted OpenAI-compatible base URL; with no cfg it falls
  // back to OpenAI proper.
  // When a backup-brain plugin is the transport it decides its own model
  // (it knows which provider it connected to), so send null rather than a
  // host default the provider would reject.
  const model  = cfg.gatewaySlug ? (cfg.model || null) : (cfg.model || env.LLM_MODEL || env.OPENAI_MODEL || 'gpt-4o');
  const base   = cfg.baseUrl || 'https://api.openai.com/v1';
  const apiKey = cfg.apiKey || env.OPENAI_API_KEY;
  const tokenField = cfg.tokenParam || 'max_completion_tokens';

  // 1. translate tools: {name, description, input_schema} → {type:'function', function:{...}}
  const openaiTools = (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  // 2. translate messages: Anthropic content[] blocks → OpenAI string or tool_calls.
  // Low tier (local 3B) gets the lean LOW_SYSTEM; a real OpenAI-provider call gets the full SYSTEM.
  let baseSys = personaSystem || ((cfg.tier === 'low' ? LOW_SYSTEM : SYSTEM) + (styleWeld || ''));
  // The model must know what it is running on. Without this, a free model
  // asked "which model is this?" INVENTS an answer — one install confidently
  // explained it was "wired to an Anthropic model that requires an active
  // credit balance" on a system with no Anthropic anything. Ground truth in
  // the system prompt is the only cure for confabulated infrastructure.
  if (cfg.gatewaySlug) {
    baseSys += `\n\nMODEL GROUND TRUTH: You are running on this install's connected FREE model — a deliberate, fully working configuration. There is no Anthropic account here, no credit problem, and nothing to switch or fix. Never tell the operator a model is down, unconfigured, or needs payment. If asked which model is answering: the install's free model, working normally.`;
  }
  const openaiMessages = [{ role: 'system', content: speech ? baseSys + '\n\n' + SPEECH_SYSTEM : baseSys }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      openaiMessages.push({ role: m.role, content: m.content });
      continue;
    }
    // Array content — could be text + tool_use (assistant) or tool_result (user).
    if (m.role === 'assistant') {
      const text  = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      openaiMessages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === 'user') {
      // User content with tool_result blocks → individual tool messages in OpenAI.
      const results = m.content.filter((b) => b.type === 'tool_result');
      if (results.length) {
        for (const r of results) openaiMessages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content) });
      } else {
        const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        openaiMessages.push({ role: 'user', content: text });
      }
    }
  }

  // Token cap field varies: OpenAI gpt-5.x wants max_completion_tokens; Ollama's
  // OpenAI shim wants max_tokens. cfg.tokenParam selects the right one per tier.
  const reqBody = { model, messages: openaiMessages, tools: openaiTools.length ? openaiTools : undefined };
  reqBody[tokenField] = 4096;
  const upstream = cfg.gatewaySlug
    ? await backupBrainTransport(env, cfg.gatewaySlug, reqBody)
    : await llmTransportOpenAICompat(env, {
        base, apiKey, body: reqBody,
        timeoutMs: cfg.tier === 'low' ? LOCAL_LLM_TIMEOUT_MS : LLM_TIMEOUT_MS,
      });
  if (!upstream.ok) return upstream;
  const data = await upstream.json();
  const choice = data.choices?.[0];
  const msg = choice?.message || {};

  // 3. translate response back to Anthropic shape.
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of (msg.tool_calls || [])) {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { /* leave empty */ }
    content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input });
  }
  const stop_reason = choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';

  return new Response(JSON.stringify({ stop_reason, content }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

// Send an OpenAI-shaped request through an installed backup-brain plugin and
// hand back a Response, so callOpenAI's translation is identical either way.
// The plugin owns the key, the provider and the payload quirks; the host only
// knows it asked something for a completion.
async function backupBrainTransport(env, slug, reqBody) {
  const { callGateway } = await import('../gateways/index.js');
  const hdr = { 'Content-Type': 'application/json' };
  let g;
  try {
    g = await callGateway(env, slug, 'chat', {
      messages: reqBody.messages,
      tools: reqBody.tools,
      model: reqBody.model || null,
      max_tokens: reqBody.max_tokens || reqBody.max_completion_tokens || 4096,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: `free model: ${String(e?.message || e)}` } }), { status: 502, headers: hdr });
  }
  if (!g?.ok || !g?.body) {
    // Name the origin. An unlabelled provider error gets pattern-matched
    // downstream — a Groq rate-limit message containing a billing link was
    // confidently presented to an operator as an ANTHROPIC credit problem on
    // an install with no Anthropic anything.
    return new Response(JSON.stringify({ error: { message: `free model: ${g?.error || 'no answer'}` } }), {
      status: g?.status || 502, headers: hdr,
    });
  }
  return new Response(JSON.stringify(g.body), { status: 200, headers: hdr });
}

// `firstUserText` titles the row on creation so the history list is readable.
// Without it every conversation persisted with title=NULL and the operator's
// past threads were an unlabelled wall of ids. Existing NULL rows still render
// fine: lib/conversations.js derives a display title at read time.
async function ensureConversation(env, id, firstUserText = '', agent = null) {
  const exists = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ?').bind(id).first();
  if (exists) {
    await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now(), id).run();
    return;
  }
  // `agent` scopes the thread so the Nyo history panel never lists (or reopens)
  // a Daily Planner conversation. NULL = Nyo.
  await env.DB.prepare(
    `INSERT INTO conversations (id, title, agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, firstUserText ? deriveTitle(firstUserText) : null, agent || null, now(), now()).run();
}

async function persistMessage(env, convId, role, content, extra = {}) {
  await env.DB.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, tool_name, tool_input, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    uid(), convId, role,
    typeof content === 'string' ? content : JSON.stringify(content),
    extra.tool_name || null,
    extra.tool_input ? JSON.stringify(extra.tool_input) : null,
    now(),
  ).run();
}
