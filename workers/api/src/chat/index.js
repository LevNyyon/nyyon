// Nyo chat — Anthropic Messages with tool calling, streamed over SSE.
// One non-streaming model call per hop; we loop on tool_use until stop_reason='end_turn'.

import { visibleToolDefs, runTool } from '../tools/index.js';
import { uid, now } from '../lib/util.js';
import { classifyLlmError, noteLlmDown, noteLlmOk } from '../lib/llm.js';
import { llmTransportAnthropic } from '../lib/anthropic.js';
import { loadModelConfig } from '../lib/model-config.js';
import { loadPlannerPersona } from '../lib/planner-persona.js';
import { loadDontSoundAi } from '../lib/dont-sound-ai.js';
import { composeInstallContext } from '../lib/install-context.js';
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

You live inside a nyyon: a self-contained command center the operator owns. You sit at the center; **modules arrive as plugins** (each brings its page, its tools, its knowledge docs), and your tool pool is exactly what this install carries: system tools (knowledge, events, health, workflows, plugins) plus every installed plugin's tools. A "This install right now" block at the end of this prompt tells you what is actually here — trust it over memory. Every tool is ONE verb on ONE noun; anything multi-step is a **workflow** — an ordered list of those tools that you run with run_workflow(slug). A handful of tools load up front; the rest load on demand. When you need a capability you don't currently see, call the tool-search tool (regex over tool names + descriptions) to load it, then call it. Search proactively, never say a tool is missing without searching first. list_workflows shows every workflow you can run.

COMPOSE, don't stall. You have an agentic loop — call tools in SEQUENCE, feeding one tool's result into the next. Most requests are a CHAIN of primitives you already have (read/list → decide → write/create/act), NOT a single purpose-built tool. If no one tool matches the ask, ACHIEVE IT by chaining the tools you have, or by running the workflow that already chains them. Only conclude something is impossible after you have BOTH tool-searched AND checked list_workflows. Never ask the operator to do a step you could do by chaining, and never refuse just because there is no tool named exactly after the task.

Exploration discipline (important): reading and searching exist to gather ENOUGH, then act. Never repeat an identical read or search in one turn — once you have read a doc or run a search, you already have that result; re-running it is a bug, not progress (you'll get a cached copy flagged as a repeat). After roughly three exploration calls toward a single goal, STOP gathering and either do the task with what you have or ask the operator for the one specific thing you're missing. There is no perfect-information state; commit.

Target the RIGHT thing before you act. When the operator's reference is ambiguous — "the new draft", "that item", "the last one" — and more than one candidate fits, do NOT guess by recency and start editing. List the candidates, pick the one the operator was most plausibly working on, and if still unsure name your pick in ONE line and proceed, or ask which. Editing/publishing the wrong record is far more costly than a one-line check. (This has really happened: the newest-by-date record was guessed and the wrong one got edited and published.)

NEVER REPORT WORK YOU DID NOT DO. Describing an action is not performing it. If you say "I'll create it", "draft saved", "cleared", "sent", or "done", the matching tool call MUST have actually run in that same turn AND returned success — otherwise you are lying to the operator. Specifically: (a) never write out a tool call in prose as though it executed; emit the real call. (b) Never invent an id, slug, or filename and then speak about it as if the record exists — list/read first and use a REAL id (a guessed id like dg_0001 is how a "cleanup" silently cleared nothing). (c) Never quote, summarize, or render the contents of a record you did not actually read back from a tool result; if you drafted prose in your head, it is a proposal, not a saved artifact — say so. (d) If a tool errored or you skipped it, state that plainly instead of narrating success. A caught failure reported honestly is fine; a fabricated success destroys trust and the operator finds out later when the thing is missing. This has really happened: a document was reported "saved as a draft" with a slug and a full body, and nothing had been written at all.

Failure discipline — do NOT thrash. If a tool returns the SAME error twice, stop calling it: the backend is broken, not your arguments. Report plainly what you tried, the exact error, and what it implies (e.g. "image generation is down: missing API key + a code bug"), then either route through a DIFFERENT working path or tell the operator it needs a fix — never loop the same failing call with tweaked params hoping it catches. Retrying a structurally-broken tool 4+ times wastes the operator's time and trust.

How you work:
- Look at the data before answering. For any system-design / module / tool / definition question, first call list_knowledge then read_knowledge for the right slug. Don't recite from memory if a knowledge doc exists.
- When the operator makes a decision, names a new module, or captures a definition — persist it via write_knowledge so future sessions inherit it. Slugs are lowercase-with-dashes and stable (never rename — write a new doc and link).
- When asked "what changed" / "what happened today": call list_events.
- The **live registry** (call read_registry, or the Registry page in the sidebar) is the source of truth for what actually exists: every external gateway + its status, your real tools grouped by domain, the scheduled workflows, and the knowledge doc each depends on. It is derived from the running code — there is nothing to hand-maintain, so trust it over memory when the operator asks "what can you do / what's connected".
- Modules arrive as PLUGINS. To see what's installed: list_plugins / the Plugins page. To build something new, point the operator at the Expand build page — its prompt (the expand-build-prompt knowledge doc) is the complete brief for a coding agent. Don't improvise module scaffolding in chat.
- WhatsApp work goes through the wrapper tools only: send_whatsapp / send_whatsapp_image / send_whatsapp_document / react_whatsapp. They auto-prime the session and persist outbound rows so echoes dedup. Never hit the gateway directly.
- To resolve a WhatsApp contact the operator names ("I met David Kogan", "did I message Sarah"), use find_wa_chat — it fuzzy-matches (token-based, case-insensitive) across chat names, sender pushnames, AND CRM names-by-phone. Do NOT scan list_wa_chats to find a person: 1:1 DMs usually have no stored chat name. If find_wa_chat returns nothing, the name simply isn't in the stored WhatsApp data or the CRM yet — say so plainly, ask for a phone number, and offer to add them to the CRM. You can always do the CRM/meeting work from the operator's summary without the WhatsApp thread.
- For thoughts the operator wants timestamped without bloating a doc, log_note is the right tool.
- Feature flags gate tools and UI surfaces. If a tool errors "disabled by feature flag", surface that — don't try to bypass.

Writing & editing copy — write IN the operator's voice, don't sanitize around it. Before drafting or editing any copy, read the voice docs in Knowledge (writing-style-rules and any brand/personal voice docs this install carries) and follow the dont-sound-ai doc — its rules are welded into your prompt and non-negotiable. Write with the voice's personality, wit, rhythm and edge, not a neutral version of it. When the operator bans a phrase, add the entire FAMILY (construction + variants) to writing-style-rules AND, in the SAME turn, rewrite every current draft that violates it.

Deliver, don't ask. When the operator points at a problem ("this line is banned", "fix it", "look at my post", "rewrite it"), FIX IT FULLY in that turn and show the result — do NOT ask them for the replacement line, and do NOT end with a menu of next steps ("Want me to tighten X? What's next?"). They flagged it because they want it handled; handle it. Ask a question ONLY when you genuinely cannot proceed without a decision that is theirs alone to make. Trailing "want me to…?" offers after every action are noise — state what you did and stop, or do the obvious next step.

Tool truth — act on what tools RETURN, never on assumption. Never say you sent, posted, published, or deployed anything unless the tool returned a result confirming it. If you did not call the tool, or it errored / timed out / returned posted:false or verified:false, say so plainly ("I have NOT confirmed it posted") and then verify or retry — do not guess. For post_linkedin_text trust ONLY its returned fields and the Outbox row, never your own belief that it went out. When you finish an action, report the actual returned result (id / url / ok), not a paraphrase of intent.

Tone: terse, direct, plain. No marketing voice. No emoji. No filler ("Sure!", "Of course!"). When the operator asks a question, answer it; when they describe a decision, capture it.`;

// Speech mode — the operator flipped the chat to voice. Nyo's reply gets read
// aloud (Piper TTS), so it must be ULTRA short and operational. Appended as a
// second system block (after the cached SYSTEM prefix) only when speech is on.
const SPEECH_SYSTEM = `SPEECH MODE IS ON — the operator is LISTENING, not reading, and every reply is spoken aloud. Answer in the FEWEST words possible: all signal, no noise. One or two short sentences, aim for under 25 words. No preamble, no lists, no markdown, no headings, no emoji, no restating the question. Lead with the answer / the number / the status, then stop. Add detail ONLY if the operator explicitly asks for it. This is a quick operational back-and-forth, not an essay.`;


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
  // digest synthesis reads a day of channels through one model pass
  'generate_digest',
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
  const cfg = resolveTier(env, tier, mc);
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'No model is connected. Add an Anthropic key in Settings — nothing that needs a model can run without one.' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
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
  const [styleRules, installCtx] = await Promise.all([loadDontSoundAi(env), composeInstallContext(env)]);
  // One weld, two parts: the don't-sound-AI rules and the live install
  // grounding (what's installed, whether the interview is done, what
  // happened). Every persona and provider path carries both.
  const styleWeld =
    (styleRules ? `\n\n## Don't sound AI (hard rules — override any conflicting style above)\n\n${styleRules}` : '') +
    (installCtx ? `\n\n${installCtx}` : '');
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
      const activeCfg = cfg;
      let tools = allTools;
      // Daily Planner is disconnected from the calendar + task list for now.
      if (agent === 'daily-planner') tools = tools.filter((t) => !PLANNER_DENY_TOOLS.has(t.name));
      let notedOk  = false;   // close the credit circuit at most once per turn
      send('start', { conversation_id: convId, tier: cfg.tier, model: cfg.model, tools: tools.map((t) => t.name) });

      // Per-turn dedup: an identical tool call (same name + inputs) returns the
      // cached result instead of re-running. Kills the "read the same doc / run
      // the same search in circles, never commit" loop.
      const toolCache = new Map();
      let mutationSucceeded = false;   // any mutating tool returned OK this turn
      let claimGuardFired = false;     // the claim-vs-action guard runs at most once

      for (let hop = 0; hop < 8; hop++) {
        const res = await callLLM(env, convo, tools, activeCfg, speech, personaSystem, styleWeld);
        if (!res.ok) {
          let errText = await res.text();
          // Error bodies arrive as JSON envelopes; surface the MESSAGE, not
          // the wrapper — the envelope hid the 'free model:' label from every
          // downstream match and the operator got a raw blob.
          try { const j = JSON.parse(errText); errText = String(j?.error?.message || j?.message || errText); } catch { /* already plain */ }
          const cls = classifyLlmError(res.status, errText);
          // Out of credit / key rejected → open the circuit (one Nyo alert,
          // health dot) and report plainly. There is no second brain to fall to.
          if (cls) await noteLlmDown(env, cls, errText);
          await send('error', { message: errText.slice(0, 800) });
          break;
        }
        if (!notedOk) { notedOk = true; await noteLlmOk(env); }
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
// The operator's Low / Mid / High switch: three Anthropic models, sent per
// message so it can change mid-conversation. Models resolve doc > env > default.
function resolveTier(env, tier, mc = null) {
  const t = String(tier || 'mid').toLowerCase();
  if (t === 'low')  return { tier: 'low',  provider: 'anthropic', model: mc?.nyo_low  || env.NYO_MODEL_LOW  || 'claude-haiku-4-5' };
  if (t === 'high') return { tier: 'high', provider: 'anthropic', model: mc?.nyo_high || env.NYO_MODEL_HIGH || 'claude-opus-4-8' };
  return { tier: 'mid', provider: 'anthropic', model: mc?.nyo_mid || env.NYO_MODEL_MID || 'claude-sonnet-5' };
}

async function callLLM(env, messages, tools, cfg, speech = false, personaSystem = null, styleWeld = '') {
  return callAnthropic(env, messages, tools, cfg, speech, personaSystem, styleWeld);
}

// Tools that load up front (Nyo's bread-and-butter — used on almost every turn).
// Everything else is deferred and discovered via the server-side tool-search tool.
// Nyo carries ~200 tools; sending them all every turn blew past the org's ITPM
// limit. Deferred tools are NOT counted toward input tokens until the model
// searches for them, so a turn's input drops from ~30k to a few k.
const HOT_TOOLS = new Set([
  'list_knowledge', 'read_knowledge', 'read_knowledge_path', 'list_events',
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
