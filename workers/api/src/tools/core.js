// Core — the shared spine every other family leans on: knowledge, the activity
// log, feature flags, workflow CRUD, the calendar, chat history, web reads, the
// live registry, health, operator notification, and the three meeting-reminder
// steps.
//
// Each tool is { def, run } returning plain JSON; assembled in tools/index.js.
// Every tool here is ONE verb on ONE noun and calls only lib functions — the
// composition lives in workflows/seeds/core.js.

import {
  listKnowledge, readKnowledge, readKnowledgePath, writeKnowledge, deleteKnowledge,
  recentEvents, logEvent,
  listFlags, setFlag,
  listWorkflows, readWorkflow, writeWorkflow, deleteWorkflow, listWorkflowRuns,
  listCalendarEvents, readCalendarEvent, upsertCalendarEvent, deleteCalendarEvent,
  CALENDAR_KINDS, CALENDAR_STATUSES,
  queueNyoMessage,
} from '../lib/db.js';
import {
  listConversations, readConversation, renameConversation, deleteConversation,
} from '../lib/conversations.js';
import { fetchArticleText } from '../lib/heartbeat.js';
import { fetchText as webGatewayFetchText } from '../lib/web-gateway.js';
import { listDueMeetings, claimDueMeetings, composeReminderDigest } from '../lib/reminders.js';
import { checkWaHealth, probeWaGateway } from '../lib/whatsapp.js';
import { probeTheorg } from '../lib/enrich-gateways.js';
import { buildRegistry } from '../lib/registry.js';

export const tools = {
  // ── knowledge ───────────────────────────────────────────────
  list_knowledge: {
    def: {
      name: 'list_knowledge',
      description: 'List every knowledge doc (slug + title + scope). Call this before reading or writing so you know what already exists.',
      input_schema: {
        type: 'object',
        properties: {
          scope:  { type: 'string', enum: ['global', 'module'] },
          module: { type: 'string', description: 'when scope=module, filter by module slug' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ docs: await listKnowledge(env, input || {}) }),
  },
  read_knowledge: {
    def: {
      name: 'read_knowledge',
      description: 'Read one knowledge doc by slug. Returns title + full markdown body. Knowledge is a tree — every doc has a `parent_slug` pointing at its parent (null for `nyyon-root`). Use `read_knowledge_path` when you need the full context chain root → … → leaf.',
      input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
    run: async (env, input) => {
      const doc = await readKnowledge(env, input.slug);
      return doc ? { found: true, doc } : { found: false };
    },
  },
  read_knowledge_path: {
    def: {
      name: 'read_knowledge_path',
      description: 'Return the breadcrumb chain root → … → :slug for a knowledge doc. The chain IS the context the operator (or any reader) needs to fully understand the leaf. Use before answering questions about a leaf doc so you ground in its parents too.',
      input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
    run: async (env, input) => ({ path: await readKnowledgePath(env, input.slug) }),
  },
  write_knowledge: {
    def: {
      name: 'write_knowledge',
      description: 'Create or update a knowledge doc. Use to capture decisions, system design, definitions, module descriptions, and every tunable rule (voice, cadence, thresholds, templates) — behaviour changes by editing a doc, not code. Slug is the stable identifier; never rename, write a new doc and link. parent_slug sets the tree position: pass a parent slug to nest, null to make it a root, or omit to keep the current parent when updating.',
      input_schema: {
        type: 'object',
        properties: {
          slug:        { type: 'string', description: 'lowercase-with-dashes' },
          title:       { type: 'string' },
          body:        { type: 'string', description: 'markdown' },
          scope:       { type: 'string', enum: ['global', 'module'] },
          module:      { type: 'string', description: 'when scope=module' },
          parent_slug: { type: ['string', 'null'], description: 'slug of the parent doc, or null for a root doc. Omit to keep the current parent when updating.' },
        },
        required: ['slug', 'title', 'body'],
      },
    },
    run: async (env, input) => ({ doc: await writeKnowledge(env, input) }),
  },
  delete_knowledge: {
    def: {
      name: 'delete_knowledge',
      description: 'Delete a knowledge doc. Use sparingly; prefer writing a new doc that supersedes the old one.',
      input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
    run: async (env, input) => { await deleteKnowledge(env, input.slug); return { ok: true }; },
  },

  // ── activity log ────────────────────────────────────────────
  list_events: {
    def: {
      name: 'list_events',
      description: 'Read the append-only activity log, newest first — knowledge writes, sends, publishes, flag flips, every meaningful mutation lands here. Use to answer "what happened / what did you do / when did X last run".',
      input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'rows to return (default 12, max 25)' } }, required: [] },
    },
    run: async (env, input) => {
      // Keep this lean: a 50-row dump with full payloads (e.g. cover URLs) bloats
      // the chat context and can blow the ITPM ceiling on the next hop. Cap rows
      // and truncate each payload.
      const raw = await recentEvents(env, Math.min(Math.max(input?.limit ?? 12, 1), 25));
      return { events: raw.map((e) => {
        let payload = '';
        try { payload = (typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload ?? {})).slice(0, 180); } catch { /* unreadable payload is not worth failing a read */ }
        return { id: e.id, kind: e.kind, actor: e.actor, created_at: e.created_at, payload };
      }) };
    },
  },
  log_note: {
    def: {
      name: 'log_note',
      description: 'Append a free-form note into the activity log. Use when the operator says "for the record" or makes a decision you want timestamped without bloating a knowledge doc.',
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    run: async (env, input) => {
      await logEvent(env, { kind: 'note', actor: 'nyo', payload: { text: input.text } });
      return { ok: true };
    },
  },
  get_telegram_pairing: {
    def: {
      name: 'get_telegram_pairing',
      description: 'The pairing code for Nyo\'s Telegram line. The operator texts this code to their Nyo bot (created with @BotFather) once; that chat becomes their direct line — questions answered with real data, queued updates pushed hourly. Also reports which chats are already paired and whether the bot token is configured.',
      input_schema: { type: 'object', properties: {} },
    },
    run: async (env) => {
      const { pairingCode, nyoTelegramCfg } = await import('../lib/nyo-telegram.js');
      const { callGateway } = await import('../gateways/index.js');
      const [code, cfg, probe] = await Promise.all([
        pairingCode(env), nyoTelegramCfg(env),
        callGateway(env, 'telegram', 'probe', {}).catch((e) => ({ ok: false, error: String(e?.message || e) })),
      ]);
      return {
        pairing_code: code,
        paired_chats: (cfg.chat_ids || []).length,
        bot: probe.ok ? probe.bot : null,
        bot_error: probe.ok ? null : probe.error,
        how: 'Text the pairing code to the bot in Telegram. One code pairs any number of your own chats.',
      };
    },
  },
  notify_operator: {
    def: {
      name: 'notify_operator',
      description: 'Queue one message for the operator to see in Nyo chat next time they look. Use as the last step of background work that produced something they must review — a drafted article, a failed send, a finished import. It queues; it never sends WhatsApp or email.',
      input_schema: {
        type: 'object',
        properties: {
          content:  { type: 'string', description: 'what the operator should read, in your own voice' },
          kind:     { type: 'string', description: 'why it was queued, e.g. system | draft_ready | alert (default system)' },
          ref_kind: { type: 'string', description: 'what it points at, e.g. blog_post | social_post | lead' },
          ref_id:   { type: 'string', description: 'id of that record, so the chat can deep-link' },
          payload:  { type: 'object', description: 'extra structured context for the chat to render' },
        },
        required: ['content'],
      },
    },
    run: async (env, input) => {
      const queued = await queueNyoMessage(env, {
        content: input.content,
        kind: input.kind || 'system',
        ref_kind: input.ref_kind || null,
        ref_id: input.ref_id || null,
        payload: input.payload || null,
      });
      await logEvent(env, { kind: 'operator_notified', actor: 'system', payload: { id: queued.id, kind: input.kind || 'system', ref_kind: input.ref_kind || null, ref_id: input.ref_id || null } });
      return { ok: true, queued: true, id: queued.id };
    },
  },

  // ── feature flags ───────────────────────────────────────────
  list_feature_flags: {
    def: {
      name: 'list_feature_flags',
      description: 'List every feature flag with its current value + scope. Surface flags gate UI sections; tool flags gate which tools you are allowed to call.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => ({ flags: await listFlags(env) }),
  },
  set_feature_flag: {
    def: {
      name: 'set_feature_flag',
      description: 'Flip a feature flag on or off. Creates the flag if it does not exist (scope defaults to tool).',
      input_schema: {
        type: 'object',
        properties: { key: { type: 'string' }, value: { type: 'boolean' } },
        required: ['key', 'value'],
      },
    },
    run: async (env, input) => { await setFlag(env, input.key, !!input.value); return { ok: true }; },
  },

  // ── workflows ───────────────────────────────────────────────
  list_workflows: {
    def: {
      name: 'list_workflows',
      description: 'List every workflow: a named outcome made of an ordered list of existing tools. Filter by source (system = shipped with the app, nyo = authored in chat) or status. Read this before authoring a new one so the operator gets a consistent shape.',
      input_schema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['system', 'nyo', 'manual'] },
          status: { type: 'string', enum: ['active', 'draft', 'disabled'] },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ workflows: await listWorkflows(env, input || {}) }),
  },
  read_workflow: {
    def: {
      name: 'read_workflow',
      description: 'Read one workflow by slug: its trigger and the full ordered step list, plus metadata. Use before editing or explaining what a workflow actually does.',
      input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
    run: async (env, input) => {
      const workflow = await readWorkflow(env, input.slug);
      return workflow ? { found: true, workflow } : { found: false };
    },
  },
  write_workflow: {
    def: {
      name: 'write_workflow',
      description: 'Create or update a runnable workflow: an ordered list of EXISTING tools with no logic of its own (rules live in knowledge; decisions live inside a tool). steps is an array of "tool_name" or {"tool":"tool_name","input":{...}} — a step with no input receives the shared run context. Every step is validated against the live tool pool before saving.',
      input_schema: {
        type: 'object',
        properties: {
          slug:        { type: 'string', description: 'kebab-case' },
          name:        { type: 'string' },
          description: { type: 'string' },
          trigger:     { type: 'object', description: 'e.g. {"kind":"manual"} or {"kind":"cron","schedule":"0 9 * * 1"}' },
          steps:       { type: 'array', items: {}, description: 'ordered steps: "tool_name" or {"tool":"tool_name","input":{...}}' },
          status:      { type: 'string', enum: ['active', 'draft', 'disabled'] },
        },
        required: ['slug', 'name', 'trigger', 'steps'],
      },
    },
    run: async (env, input) => {
      // Dynamic import: the runner imports the tool pool, so a static import here
      // would close the cycle.
      const { validateWorkflowSteps } = await import('../workflows/runner.js');
      const problems = await validateWorkflowSteps(env, input.steps);
      if (problems.length) return { ok: false, error: 'steps failed validation against the tool pool', problems };
      return { ok: true, workflow: await writeWorkflow(env, { ...input, source: 'nyo', created_by: 'nyo', updated_by: 'nyo' }) };
    },
  },
  delete_workflow: {
    def: {
      name: 'delete_workflow',
      description: 'Delete a workflow. Refuses system-source workflows — those ship with the app and other code triggers them by slug.',
      input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
    run: async (env, input) => {
      const w = await readWorkflow(env, input.slug);
      if (w?.source === 'system') return { ok: false, error: 'cannot delete system workflows' };
      await deleteWorkflow(env, input.slug);
      return { ok: true };
    },
  },
  run_workflow: {
    def: {
      name: 'run_workflow',
      description: 'Execute a stored workflow: each step dispatches into the shared tool pool with one threaded context, and the full trail lands in workflow_runs + workflow_step_runs. Fails fast on the first failing step. `input` is the initial shared context handed to step 1.',
      input_schema: {
        type: 'object',
        properties: {
          slug:  { type: 'string' },
          input: { type: 'object', description: 'initial shared context (optional)' },
        },
        required: ['slug'],
      },
    },
    run: async (env, input) => {
      const { runWorkflow } = await import('../workflows/runner.js');
      return runWorkflow(env, input.slug, input.input || {});
    },
  },
  list_workflow_runs: {
    def: {
      name: 'list_workflow_runs',
      description: 'List recent workflow runs — every fire leaves a row. Filter by workflow_slug or status. Use for "how often did the writer fire this week" or "what failed last night".',
      input_schema: {
        type: 'object',
        properties: {
          workflow_slug: { type: 'string' },
          status:        { type: 'string', enum: ['running', 'succeeded', 'failed'] },
          limit:         { type: 'number' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ runs: await listWorkflowRuns(env, input || {}) }),
  },

  // ── calendar (the central event store) ──────────────────────
  list_calendar_events: {
    def: {
      name: 'list_calendar_events',
      description: 'List calendar events in a time range. from/to are ms-epoch. Filter by kind (meeting/social_post/blog_publish/campaign/deadline/other) or source (manual/nyo/blog/aeo/social/external). Returns events sorted by starts_at ascending.',
      input_schema: {
        type: 'object',
        properties: {
          from:   { type: 'number', description: 'starts_at >= this ms epoch' },
          to:     { type: 'number', description: 'starts_at <= this ms epoch' },
          kind:   { type: 'string', enum: CALENDAR_KINDS },
          source: { type: 'string' },
          limit:  { type: 'number' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({ events: await listCalendarEvents(env, input || {}) }),
  },
  read_calendar_event: {
    def: {
      name: 'read_calendar_event',
      description: 'Read one calendar event by id (ce_…), including its agenda body, attendees and link.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => {
      const event = await readCalendarEvent(env, input.id);
      return event ? { found: true, event } : { found: false };
    },
  },
  write_calendar_event: {
    def: {
      name: 'write_calendar_event',
      description: 'Create or update a calendar event; omit id to create. The calendar is the central event store — use it for meetings, deadlines, campaign milestones and anything else with a date. Blog publishes mirror in automatically, so never create blog_publish events by hand. starts_at is required and is ms epoch.',
      input_schema: {
        type: 'object',
        properties: {
          id:          { type: 'string', description: 'omit to create' },
          kind:        { type: 'string', enum: CALENDAR_KINDS },
          title:       { type: 'string' },
          description: { type: 'string' },
          starts_at:   { type: 'number', description: 'ms epoch' },
          ends_at:     { type: 'number', description: 'ms epoch; optional' },
          all_day:     { type: 'boolean' },
          status:      { type: 'string', enum: CALENDAR_STATUSES },
          link_url:    { type: 'string' },
          location:    { type: 'string' },
          attendees:   { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } } },
          body:        { type: 'string', description: 'long-form agenda / draft / notes' },
          platform:    { type: 'string', description: 'for social_post: linkedin|x|facebook|tiktok|instagram' },
        },
        required: ['title', 'starts_at'],
      },
    },
    run: async (env, input) => ({ event: await upsertCalendarEvent(env, { ...input, source: input.source || 'nyo', updated_by: 'nyo' }) }),
  },
  delete_calendar_event: {
    def: {
      name: 'delete_calendar_event',
      description: 'Remove a calendar event by id. Use sparingly — prefer write_calendar_event with status=cancelled to keep the audit trail.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async (env, input) => { await deleteCalendarEvent(env, input.id); return { ok: true }; },
  },

  // ── conversations (Nyo's own history) ───────────────────────
  list_conversations: {
    def: {
      name: 'list_conversations',
      description: 'List past Nyo conversations, newest first: id, title, message count and timestamps. Read-only. Use to answer "what did we talk about" or before reading one in full.',
      input_schema: {
        type: 'object',
        properties: {
          limit:  { type: 'number', description: 'how many to return (default 40, max 200)' },
          offset: { type: 'number', description: 'skip this many for paging' },
        },
        required: [],
      },
    },
    run: async (env, input) => listConversations(env, { ...(input || {}), agent: null }),
  },
  read_conversation: {
    def: {
      name: 'read_conversation',
      description: 'Read one past conversation in full: every user and assistant turn in order, with the tools that ran. Read-only. Use after list_conversations to recall exactly what was said or decided.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'conversation id from list_conversations' } },
        required: ['id'],
      },
    },
    run: async (env, input) => {
      const conversation = await readConversation(env, input?.id, { agent: null });
      return conversation ? { found: true, conversation } : { found: false, conversation: null, id: input?.id };
    },
  },
  rename_conversation: {
    def: {
      name: 'rename_conversation',
      description: 'Give a past conversation an explicit title so it is easy to find later. Overrides the title derived from its first message.',
      input_schema: {
        type: 'object',
        properties: {
          id:    { type: 'string', description: 'conversation id' },
          title: { type: 'string', description: 'the new title' },
        },
        required: ['id', 'title'],
      },
    },
    run: async (env, input) => renameConversation(env, input?.id, input?.title),
  },
  delete_conversation: {
    def: {
      name: 'delete_conversation',
      description: 'Permanently delete one PAST conversation and all of its messages. Destructive and irreversible: confirm the exact conversation with the operator first. Refuses to delete the conversation currently in progress.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'conversation id' } },
        required: ['id'],
      },
    },
    // ctx carries the live conversation id so this can refuse to destroy the
    // thread it is running inside.
    run: async (env, input, ctx = {}) => deleteConversation(env, input?.id, { activeId: ctx.conversation_id || null }),
  },

  // ── web ─────────────────────────────────────────────────────
  fetch_web_page: {
    def: {
      name: 'fetch_web_page',
      description: 'Fetch a public web page or JSON/text endpoint over http(s) and return its readable text (HTML stripped, prefers the article/main body, capped). Use to read an article, check a live page, or pull a public API before answering.',
      input_schema: {
        type: 'object',
        properties: {
          url:       { type: 'string', description: 'http(s) URL to fetch' },
          max_chars: { type: 'number', description: 'cap on returned text (default 12000, max 40000)' },
        },
        required: ['url'],
      },
    },
    run: async (env, input) => {
      const url = String(input.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
      const cap = Math.min(40000, Math.max(500, Number(input.max_chars) || 12000));
      // Reuse the heartbeat extractor for HTML (strips script/nav/footer, prefers <article>/<main>).
      let content = await fetchArticleText(env, url, { maxChars: cap });
      let status = 200;
      if (!content) {
        // Non-HTML (JSON/text) or a page too thin for the extractor → raw text
        // via the shared web gateway. Only double-fetches when the first
        // extraction came back empty.
        const r = await webGatewayFetchText(env, { url, max_bytes: cap * 4 });
        status = r.status;
        content = r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap);
      }
      return { url, status, truncated: content.length >= cap, content };
    },
  },

  // ── the system itself ───────────────────────────────────────
  read_registry: {
    def: {
      name: 'read_registry',
      description: 'The LIVE system registry — every external gateway with its configured/missing status, the real tool pool grouped by domain, the scheduled and on-demand workflows, and the knowledge docs each depends on. Derived from running code, so trust it over memory for "what can you do / what is connected / what powers X".',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => buildRegistry(env),
  },
  check_health: {
    def: {
      name: 'check_health',
      description: 'Probe every service this system depends on and report status: the worker itself, the WhatsApp gateway + its session, the org-chart gateway, and which optional enrichment keys are configured. Use for "is everything up", "why is X down", or before starting long work that needs WhatsApp or enrichment.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => {
      const wa = await checkWaHealth(env);
      const gw = await probeWaGateway(env);
      const theorg = await probeTheorg(env);
      return {
        nyyon_worker: { ok: true, note: 'this tool ran, so the worker is up' },
        whatsapp_gateway: { ok: gw.reachable, url: gw.url, http: gw.http, error: gw.error },
        wa_session: { ok: wa.ok, status: wa.status, error: wa.error },
        gtm_theorg: theorg,
        gtm_enrichment_keys: {
          pdl:     !!env.PDL_API_KEY,
          serpapi: !!env.SERPAPI_KEY,
          twilio:  !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
          note:    'optional — unset legs skip gracefully during enrichment',
        },
      };
    },
  },

  // ── meeting reminders (the three steps of the workflow) ─────
  list_due_meetings: {
    def: {
      name: 'list_due_meetings',
      description: 'List meetings that are due a reminder and have not had one yet, using the meeting-reminders policy (lead minutes, which calendar kinds, the target chat). Read-only — nothing is claimed — so it is also the cheap way to check whether a reminder run is worth starting. Returns {due_meetings, chatId, lead_minutes}.',
      input_schema: {
        type: 'object',
        properties: { hours: { type: 'number', description: 'widen the window to the next N hours instead of the policy lead time' } },
        required: [],
      },
    },
    run: async (env, input) => listDueMeetings(env, { hours: input?.hours ?? null }),
  },
  claim_due_meetings: {
    def: {
      name: 'claim_due_meetings',
      description: 'Take the reminder lock on each due meeting BEFORE anything is sent, and return only the ones this call actually won. Reads due_meetings from the run context. Rows another run already claimed are dropped, which is what makes a reminder at-most-once.',
      input_schema: {
        type: 'object',
        properties: { due_meetings: { type: 'array', items: { type: 'object' }, description: 'rows from list_due_meetings' } },
        required: [],
      },
    },
    run: async (env, input) => claimDueMeetings(env, input?.due_meetings || []),
  },
  compose_reminder: {
    def: {
      name: 'compose_reminder',
      description: 'Turn the claimed meetings into the one message the operator will receive — title, time, location, attendees, notes and link per meeting, combined so three back-to-back meetings arrive as one buzz. Deterministic template, no reasoning. Returns {chatId, text}, with text null when nothing was claimed.',
      input_schema: {
        type: 'object',
        properties: {
          claimed_meetings: { type: 'array', items: { type: 'object' }, description: 'rows from claim_due_meetings' },
          chatId:           { type: 'string', description: 'override the policy target chat' },
        },
        required: [],
      },
    },
    run: async (env, input) => composeReminderDigest(env, {
      claimed_meetings: input?.claimed_meetings || [],
      chatId: input?.chatId || null,
    }),
  },
};
