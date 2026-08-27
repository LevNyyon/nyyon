
## core family
tools: list_knowledge, read_knowledge, read_knowledge_path, write_knowledge, delete_knowledge, list_events, log_note, notify_operator, list_feature_flags, set_feature_flag, list_workflows, read_workflow, write_workflow, delete_workflow, run_workflow, list_workflow_runs, list_calendar_events, read_calendar_event, write_calendar_event, delete_calendar_event, list_conversations, read_conversation, rename_conversation, delete_conversation, fetch_web_page, read_registry, check_health, list_due_meetings, claim_due_meetings, compose_reminder
workflows: meeting-reminders
route migrations:
- OLD: workers/api/src/index.js:394-396 — GET /api/nyo/pending: c.executionCtx.waitUntil(import('./lib/reminders.js').then((m) => m.checkMeetingReminders(c.env)).catch(() => {}))
  NEW: c.executionCtx.waitUntil((async () => { const due = await runTool(c.env, 'list_due_meetings', {}); if (due.due_meetings?.length) await runWorkflow(c.env, 'meeting-reminders', {}, { trigger_kind: 'poll' }); })().catch(() => {}))
  NOTE: The gate is required, not cosmetic. The workflow's send_whatsapp step is mandatory (marking it optional:true would turn a real delivery failure into a green run and break the fail-closed guarantee), so a tick with nothing due would fail on 'text required' and flood workflow_runs. list_due_meetings is read-only and claims nothing, so using it as the gate has no side effects. Note the per-isolate 1/min throttle that lived inside checkMeetingReminders disappears with it — if the poll still needs throttling, that belongs in the trigger, not the workflow.
- OLD: workers/api/src/index.js:816-819 — POST /api/reminders/check: const { checkMeetingReminders } = await import('./lib/reminders.js'); return c.json(await checkMeetingReminders(c.env, { force: true }));
  NEW: const due = await runTool(c.env, 'list_due_meetings', {}); if (!due.due_meetings?.length) return c.json({ ...due, ran: false }); return c.json(await runWorkflow(c.env, 'meeting-reminders', {}, { trigger_kind: 'manual' }));
  NOTE: Same gate. The response shape changes from {checked,sent,failed} to the runner's {ok,run_id,results,output} — the Reminders panel's 'check now' button reads it, so update the frontend handler in the same pass.
- OLD: workers/api/src/index.js:2571-2588 — scheduled() reminders leg: checkMeetingReminders(env, {}) wrapped in a hand-rolled logWorkflowRun(env, { workflow_slug: 'meeting-reminders', ... }) for both success and failure
  NEW: const due = await runTool(env, 'list_due_meetings', {}); if (due.due_meetings?.length) { const r = await runWorkflow(env, 'meeting-reminders', {}, { trigger_kind: 'cron' }); console.log('[reminders-cron]', cron, JSON.stringify(r)); }
  NOTE: DELETE both logWorkflowRun calls in this block. runWorkflow writes workflow_runs + workflow_step_runs itself, so keeping the manual logging writes two rows per tick. The existing comment explaining why the trail is logged 'HERE only' becomes false and should go with it.
- OLD: workers/api/src/tools/index.js — imports of ./knowledge.js, ./activity-log.js, ./feature-flags.js, ./workflows.js, ./calendar.js, ./conversations.js, ./web.js, ./meeting-reminders.js and their spreads into TOOL_REGISTRY
  NEW: import { tools as coreTools } from './core.js'; ...coreTools
  NOTE: All eight files are fully superseded by tools/core.js and must be dropped from the registry, not left alongside it — knowledge/workflows/calendar/conversations/feature-flags define identical tool names and would shadow depending on spread order. get_meeting_reminders and set_meeting_reminders are not in the v2 Core list and disappear with tools/meeting-reminders.js; the Reminders panel keeps editing settings through PUT /api/reminders, which is unchanged.
- OLD: workers/api/src/tools/whatsapp.js:196-227 — read_registry and system_health
  NEW: read_registry and check_health now live in tools/core.js
  NOTE: Per the spec's referee note, registry/health/notify moved to Core. The WhatsApp family's rewrite of tools/whatsapp.js should not re-export either (its v2 list is 12 tools and contains neither). If both files land unedited there is a duplicate read_registry key.
- OLD: workers/api/src/tools/funnel.js:46 — list_events (recent WEB analytics events)
  NEW: COLLISION — resolve before wiring
  NOTE: The spec renames the activity-log tool recent_events -> list_events, and tools/funnel.js already exports a DIFFERENT list_events for web funnel events. There is no Funnel family in ARCHITECTURE-V2, so funnel.js should be dropped from TOOL_REGISTRY; if it survives, whichever spread comes second silently wins and one of the two tools vanishes with no error.
- OLD: workers/api/src/chat/index.js:329 and :338 — HOT_TOOLS and LOW_TOOLS sets contain 'recent_events'
  NEW: 'list_events'
  NOTE: Stale names here fail silently: the tool simply never loads into the model's hot set.
- OLD: workers/api/src/chat/index.js:346 — LOW_TOOLS contains 'system_health'
  NEW: 'check_health'
  NOTE: Same silent-failure mode; this is the local-Qwen tier's only diagnostics entry.
- OLD: workers/api/src/chat/index.js:14-17 — PLANNER_DENY_TOOLS contains 'get_meeting_reminders', 'set_meeting_reminders'
  NEW: drop both names; add 'list_due_meetings', 'claim_due_meetings', 'compose_reminder' if the planner agent should stay cut off from the reminder pipeline
  NOTE: Both old names cease to exist. The deny-set is a Set of strings with no validation, so dead entries are invisible.
- OLD: workers/api/src/chat/index.js:37, :76, :78 — SYSTEM prompt prose naming recent_events and system_health
  NEW: list_events and check_health
  NOTE: Prompt text only, but it is what makes Nyo reach for the right tool by name.
- OLD: workers/api/src/lib/registry.js:167 — { group: 'Knowledge', re: /knowledge|log_note|recent_events/, knowledge: [] }
  NEW: re: /knowledge|log_note|list_events|notify_operator/
  NOTE: Cosmetic grouping on the Registry page, but a stale regex drops list_events out of every group and it renders ungrouped.

## planner family
tools: read_daily_plan, save_daily_plan, update_daily_plan, search_daily_plans, list_recent_plans, read_weekly_objectives, set_weekly_objectives
route migrations:

## whatsapp family
tools: send_whatsapp, send_whatsapp_image, send_whatsapp_document, react_whatsapp, list_wa_groups, list_wa_chats, find_wa_chat, read_group_participants, set_chat_listening, restart_wa_session, backfill_wa_messages, backfill_lid_map
route migrations:
- OLD: index.js:2122 — app.get('/api/wa/chats', … listChats(c.env))  [direct lib call, not runTool]
  NEW: c.json(await runTool(c.env, 'list_wa_chats', {}))
  NOTE: Tool returns {chats, total_in_db, total_listening}; web/src/lib/api.ts reads r.chats so the client stays compatible. Pass {limit: 500} if the UI needs the full list — the tool caps at 50 by default.
- OLD: index.js:2125 — app.get('/api/wa/search', … searchWaChats(c.env, {query, limit}))
  NEW: c.json(await runTool(c.env, 'find_wa_chat', { query: q, limit: Number(c.req.query('limit')) || 15 }))
  NOTE: Identical response shape {query, matches[]} — drop-in swap.
- OLD: index.js:2130 — app.put('/api/wa/chats/:id', … setChatPolicy(c.env, id, body))
  NEW: KEEP on lib setChatPolicy for the general patch; only auto_listen-only call sites become runTool(c.env, 'set_chat_listening', { chat_id: id, listening: !!body.auto_listen })
  NOTE: Deliberate non-migration: the Channels UI (api.ts patchWaChat / waSetChatPolicy) also patches can_send and name, which set_chat_listening does not cover (spec scopes it to the digest listener flag). Migrating the whole route would silently drop those two fields.
- OLD: index.js:2142 — app.post('/api/wa/send', … sendText(c.env, body))
  NEW: c.json(await runTool(c.env, 'send_whatsapp', { chatId: body.chatId, text: body.text }))
  NOTE: Same outbox-audited path (tool → gateway → same lib); keep the try/catch → 500 so the route still surfaces failures. No retry added anywhere.
- OLD: index.js:2147 — app.post('/api/wa/send-image', … sendImage(c.env, body))
  NEW: c.json(await runTool(c.env, 'send_whatsapp_image', { chatId: body.chatId, url: body.url, caption: body.caption }))
  NOTE: Drop-in; same {messageId, timestamp, chatId, outbox_id}.
- OLD: index.js:2152 — app.post('/api/wa/send-document', … sendDocument(c.env, body))
  NEW: c.json(await runTool(c.env, 'send_whatsapp_document', { chatId: body.chatId, url: body.url, filename: body.filename, mimetype: body.mimetype }))
  NOTE: Drop-in; filename stays required (lib throws without it).
- OLD: index.js:2157 — app.post('/api/wa/react', … reactToMessage(c.env, body))
  NEW: c.json(await runTool(c.env, 'react_whatsapp', { messageId: body.messageId, reaction: body.reaction }))
  NOTE: Drop-in; returns {ok, outbox_id}.
- OLD: index.js:2165 — app.get('/api/wa/groups', … listWaGroups(c.env))
  NEW: c.json(await runTool(c.env, 'list_wa_groups', {}))
  NOTE: Drop-in; same {groups[], source, live_error}.
- OLD: index.js:2178 — app.post('/api/wa/restart-session', … restartWaSession(c.env))
  NEW: c.json(await runTool(c.env, 'restart_wa_session', {}))
  NOTE: Drop-in; returns {ok, status} and still throws (→ 500) if the session never reaches ready.
- OLD: index.js:2182 — app.post('/api/wa/backfill', … backfillMessages(c.env, body))
  NEW: c.json(await runTool(c.env, 'backfill_wa_messages', { limit: body.limit, chatId: body.chatId }))
  NOTE: Response gains `skipped` (fetched − inserted = already-cached rows) alongside inserted/fetched/per_chat/chats_scanned/warning, per the spec out shape.
- OLD: index.js:2495 (scheduled() cron leg) — const { backfillWaLidMap } = await import('./lib/whatsapp.js'); await backfillWaLidMap(env, { limit: 50 })
  NEW: await runTool(env, 'backfill_lid_map', { limit: 50 })
  NOTE: Same {pending, resolved} the log line already prints; removes the dynamic lib import from the cron.
- OLD: index.js:2517 (scheduled() cron leg) — const { backfillMessages } = await import('./lib/whatsapp.js'); await backfillMessages(env, { allAutoListen: true, limit: 30 })
  NEW: await runTool(env, 'backfill_wa_messages', { limit: 30 })
  NOTE: Equivalent: omitting chatId covers every auto_listen chat (allAutoListen defaults true in lib). The log line reads r.inserted / r.chats_scanned, both still present.
- OLD: (none) — no runTool(...) call anywhere in index.js references an old WhatsApp-family tool name
  NEW: n/a
  NOTE: Verified by grep over workers/api/src: the old family was Nyo-chat-only plus the direct-lib routes listed above. Remaining hits are prose/comments.

## outreach family
tools: list_prospect_threads, read_prospect_thread, mark_thread_dead, read_lead_angles, read_drafting_rules, save_drafting_rules, pick_next_bubble, compose_reply, list_cohorts, create_cohort, update_cohort, delete_cohort, read_sequence, save_sequence, draft_step_copy, read_cadence, save_cadence, list_cohort_members, enroll_members, launch_members, approve_message, override_message, reschedule_member, pause_member, stop_member, unschedule_member, remove_member, list_due_members, retire_answered_members, render_member_messages, gate_member_approvals, send_due_messages, collect_replies, promote_replies, read_promotion_rules, save_promotion_rules, schedule_send, cancel_scheduled_send, list_scheduled_sends, run_due_sends, send_outreach
workflows: draft-prospect-reply, outreach-cohort-tick, outreach-replies-to-pipeline, scheduled-send-tick
route migrations:
- OLD: index.js:1235 POST /api/gtm/leads/:id/schedule — runTool(c.env, 'gtm_schedule_send', { id, bubbles, send_at })
  NEW: runTool(c.env, 'schedule_send', { id, bubbles, send_at })
  NOTE: Same input. Output now carries schedule_id AND the original id, so no client change is forced.
- OLD: index.js:1237 GET /api/gtm/schedules — runTool(c.env, 'gtm_list_scheduled', { id: c.req.query('lead') })
  NEW: runTool(c.env, 'list_scheduled_sends', { lead_id: c.req.query('lead') || undefined })
  NOTE: INPUT KEY RENAMED: the lead filter is lead_id, not id. Same {schedules, defaults} output.
- OLD: index.js:1238 DELETE /api/gtm/schedules/:id — runTool(c.env, 'gtm_cancel_scheduled', { id })
  NEW: runTool(c.env, 'cancel_scheduled_send', { schedule_id: c.req.param('id') })
  NOTE: INPUT KEY RENAMED to schedule_id. Output gains action:'cancelled'|'dismissed'.
- OLD: index.js:1242 POST /api/gtm/leads/:id/send — sendOutreach(c.env, { lead_id, bubbles }) called straight from the lib (import at index.js:67)
  NEW: runTool(c.env, 'send_outreach', { id: c.req.param('id'), bubbles: b.bubbles, force: !!b.force })
  NOTE: A route reaching past the pool into the lib. Drop sendOutreach from the index.js import at line 67 once migrated.
- OLD: index.js:1347 GET /api/outreach/wa/threads — runTool(c.env, 'outreach_wa_threads', { q, limit, status })
  NEW: runTool(c.env, 'list_prospect_threads', { q, limit, status })
  NOTE: Identical input and output.
- OLD: index.js:1354 POST /api/outreach/wa/dead — runTool(c.env, 'outreach_mark_dead', { lead_id, dead, reason })
  NEW: runTool(c.env, 'mark_thread_dead', { lead_id, dead, reason })
  NOTE: Identical input and output.
- OLD: index.js:1361 GET /api/outreach/cohort — runTool(c.env, 'outreach_cohort_list', { status, cohort_id })
  NEW: runTool(c.env, 'list_cohort_members', { status, cohort_id })
  NOTE: Identical input and output.
- OLD: index.js:1367 GET /api/outreach/cohorts — runTool(c.env, 'outreach_cohorts', {})
  NEW: runTool(c.env, 'list_cohorts', {})
  NOTE: Identical.
- OLD: index.js:1370 POST /api/outreach/cohorts — runTool(c.env, 'outreach_cohort_create', { name, note })
  NEW: runTool(c.env, 'create_cohort', { name, note })
  NOTE: Identical.
- OLD: index.js:1375 PATCH /api/outreach/cohorts/:id — runTool(c.env, 'outreach_cohort_update', { ...b, cohort_id })
  NEW: runTool(c.env, 'update_cohort', { ...b, cohort_id: c.req.param('id') })
  NOTE: Identical.
- OLD: index.js:1381 POST /api/outreach/cohorts/:id/draft-step — runTool(c.env, 'outreach_step_draft', { cohort_id, step_index, language, instruction })
  NEW: runTool(c.env, 'draft_step_copy', { cohort_id, step_index, language, instruction })
  NOTE: Identical.
- OLD: index.js:1388 DELETE /api/outreach/cohorts/:id — runTool(c.env, 'outreach_cohort_delete', { cohort_id })
  NEW: runTool(c.env, 'delete_cohort', { cohort_id: c.req.param('id') })
  NOTE: Identical.
- OLD: index.js:1394 POST /api/outreach/cohort/enroll — runTool(c.env, 'outreach_cohort_enroll', { lead_id, cohort_id, override, start_at })
  NEW: runTool(c.env, 'enroll_members', { lead_ids: [b.lead_id], cohort_id, override })
  NOTE: SHAPE CHANGE: the single-enrol tool is gone, enroll_members is the one staging verb. The reply is {added[], conflicts[], skipped[]} rather than a bare {conflict:true}/{added:true}; the UI's conflict prompt must read conflicts[0]. start_at is dropped on purpose — enrolling never schedules; launch_members/reschedule_member set the time.
- OLD: index.js:1404 POST /api/outreach/cohort/add-many — runTool(c.env, 'outreach_cohort_add_many', { lead_ids, cohort_id, override })
  NEW: runTool(c.env, 'enroll_members', { lead_ids, cohort_id, override })
  NOTE: Identical input and output — this and the enroll route now hit the same tool.
- OLD: index.js:1414 POST /api/outreach/cohort/approve — runTool(c.env, 'outreach_cohort_approve', { lead_ids, approve })
  NEW: runTool(c.env, 'approve_message', { lead_ids, approve })
  NOTE: Identical.
- OLD: index.js:1423 PUT /api/outreach/cohort/:lead_id/message — runTool(c.env, 'outreach_cohort_edit_message', { lead_id, text, clear })
  NEW: runTool(c.env, 'override_message', { lead_id, text, clear })
  NOTE: Identical.
- OLD: index.js:1432 PUT /api/outreach/cohort/:lead_id/schedule — runTool(c.env, 'outreach_cohort_reschedule', { lead_id, send_at })
  NEW: runTool(c.env, 'reschedule_member', { lead_id, send_at })
  NOTE: Identical.
- OLD: index.js:1439 POST /api/outreach/cohort/control — runTool(c.env, 'outreach_cohort_control', { lead_id, action })
  NEW: dispatch on b.action: 'pause'→runTool(c.env,'pause_member',{lead_id, paused:true}); 'resume'→runTool(c.env,'pause_member',{lead_id, paused:false}); 'stop'→runTool(c.env,'stop_member',{lead_id}); 'unschedule'→runTool(c.env,'unschedule_member',{lead_id})
  NOTE: The one action-string tool split into three verbs. Either map in this route or give each verb its own route; an unknown action should 400 rather than silently no-op.
- OLD: index.js:1443 DELETE /api/outreach/cohort/:lead_id — runTool(c.env, 'outreach_cohort_remove', { lead_id })
  NEW: runTool(c.env, 'remove_member', { lead_id: c.req.param('lead_id') })
  NOTE: Identical.
- OLD: index.js:1447 POST /api/outreach/cohort/tick — runTool(c.env, 'outreach_cohort_tick', { dry_run, force, limit })
  NEW: runWorkflow(c.env, 'outreach-cohort-tick', { dry_run: b?.dry_run === undefined ? null : !!b.dry_run, force: !!b?.force, limit: b?.limit || null })
  NOTE: SHAPE CHANGE: the reply is now {ok, run_id, steps, results[], output}. The old fields live on output — output.ran / output.dry_run / output.live / output.budget / output.awaiting_approval / output.sent / output.results, plus output.due (now the ARRAY of due rows, not a count — use output.due.length), output.retired, output.blocked, output.awaiting, output.unverified. Reshape here so the Cohorts page keeps its contract.
- OLD: index.js:1453 GET /api/outreach/cohorts/:id/sequence — runTool(c.env, 'outreach_sequence', { cohort_id })
  NEW: runTool(c.env, 'read_sequence', { cohort_id: c.req.param('id') })
  NOTE: The read/write overload is split; identical output.
- OLD: index.js:1457 PUT /api/outreach/cohorts/:id/sequence — runTool(c.env, 'outreach_sequence', { cohort_id, sequence, scope })
  NEW: runTool(c.env, 'save_sequence', { cohort_id: c.req.param('id'), sequence, scope })
  NOTE: Identical input and output; sequence is now required by the schema, so keep the `|| { steps: [] }` default in the route.
- OLD: index.js:1465 POST /api/outreach/cohort/go-live — runTool(c.env, 'outreach_cohort_go_live', { lead_ids, start_at })
  NEW: runTool(c.env, 'launch_members', { lead_ids, start_at })
  NOTE: Identical.
- OLD: index.js:1468 GET /api/outreach/cohort/settings — runTool(c.env, 'outreach_cohort_settings', {})
  NEW: runTool(c.env, 'read_cadence', {})
  NOTE: The read/write overload is split; identical output.
- OLD: index.js:1470 PUT /api/outreach/cohort/settings — runTool(c.env, 'outreach_cohort_settings', body)
  NEW: runTool(c.env, 'save_cadence', body)
  NOTE: Identical output. Note the old tool read when the body was empty; save_cadence always writes, so an empty PUT is now a no-op write of the current values.
- OLD: index.js:1477 GET /api/outreach/wa/thread — runTool(c.env, 'outreach_wa_thread', { chat_id, lead_id, limit })
  NEW: runTool(c.env, 'read_prospect_thread', { chat_id, lead_id, limit })
  NOTE: Same input; the output gains top-level lead_id and answered.
- OLD: index.js:1486 POST /api/outreach/wa/draft — runTool(c.env, 'outreach_draft_reply', { chat_id, lead_id, force_llm })
  NEW: runWorkflow(c.env, 'draft-prospect-reply', { chat_id, lead_id, force_llm })
  NOTE: SHAPE CHANGE: the composer's draft is now at output.draft / output.source (plus output.step, output.alternatives, output.first_touch, output.reason). Reshape here so the composer keeps its contract.
- OLD: index.js:1491 GET /api/outreach/wa/settings — runTool(c.env, 'outreach_wa_settings', {})
  NEW: runTool(c.env, 'read_drafting_rules', {})
  NOTE: The read/write overload is split; identical output.
- OLD: index.js:1493 PUT /api/outreach/wa/settings — runTool(c.env, 'outreach_wa_settings', body)
  NEW: runTool(c.env, 'save_drafting_rules', body)
  NOTE: Identical output.
- OLD: index.js:2427 cron leg — import { runCohortTick } from './lib/outreach-cohorts.js'; await runCohortTick(env, {})
  NEW: runWorkflow(env, 'outreach-cohort-tick', {}, { trigger_kind: 'cron' })
  NOTE: The cron reaches straight into the lib today. After migrating, drop the hand-rolled logWorkflowRun({workflow_slug:'outreach-queue-tick'}) beside it — runWorkflow writes its own workflow_runs trail, and the slug is now outreach-cohort-tick. The console.log fields move to r.output (ran, due.length, sent, dry_run).
- OLD: index.js:2505 cron leg — import { runDueScheduled } from './lib/gtm-schedule.js'; await runDueScheduled(env)
  NEW: runWorkflow(env, 'scheduled-send-tick', {}, { trigger_kind: 'cron' })
  NOTE: Same lib guarantee underneath (run_due_sends wraps runDueScheduled); the tick now gets an auditable workflow_runs row. Log from r.output.claimed/sent/failed.
- OLD: index.js:2562 cron leg — r?.results?.find((s) => s.tool === 'outreach_promote_replies')?.result
  NEW: r?.results?.find((s) => s.tool === 'promote_replies')?.result
  NOTE: The runWorkflow call at index.js:2561 already targets the right slug, but it reads the result by OLD step name and would silently log undefined counts after the rename.

## prospecting family
tools: read_lead, lookup_wa_identity, lookup_company_from_linkedin, enrich_person_pdl, lookup_line_twilio, search_socials_serp, fetch_org_chart, fetch_company_profile, fetch_open_roles, reconcile_identity, score_icp, save_lead, save_org_chart, draft_angles, save_angles, list_green_leads, read_you, promote_lead, audit_identities, update_api_limits
workflows: enrich-lead, company-context, qualify-lead, draft-outreach-angles, clean-identity
route migrations:
- OLD: index.js:1199 POST /api/gtm/leads/:id/enrich → gtmEnrichFull(c.env, id) (lib call; Nyo tool gtm_enrich_lead)
  NEW: runWorkflow(c.env, 'enrich-lead', { id })
  NOTE: The batch drain (POST /api/gtm/enrich, gtmEnrichBatchStep) should loop this workflow per lead id. b.kind==='resume' also maps to 'enrich-lead' — the sources self-skip, so a resume costs nothing extra except the two legs a manual edit unblocks. b.kind==='wa' maps to runTool('lookup_wa_identity') → runTool('reconcile_identity') → runTool('save_lead'), or just re-run the workflow.
- OLD: index.js:1214 POST /api/gtm/leads/:id/company-context → companyContextForLead(c.env, id, {refresh}) (Nyo tool gtm_company_context)
  NEW: runWorkflow(c.env, 'company-context', { id, refresh })
  NOTE: Same partial-by-design behaviour: the three fetch legs are optional steps, so a failure is recorded in workflow_step_runs and save_lead's coalesce keeps known facts.
- OLD: index.js:1208 POST /api/gtm/leads/:id/theorg → orgChartForLead(c.env, {id, refresh, slug}) (Nyo tool gtm_org_chart)
  NEW: runWorkflow(c.env, 'company-context', { id, theorg_slug: b.slug, refresh: !!b.refresh })
  NOTE: The slug override is now the theorg_slug input key. If the UI needs the chart alone, runTool('fetch_org_chart') → runTool('reconcile_identity') → runTool('save_org_chart') is the narrower pair; the workflow is the maintained path.
- OLD: index.js:1218 POST /api/gtm/leads/:id/icp → scoreIcpFit(c.env, id) (Nyo tool gtm_score_icp)
  NEW: runWorkflow(c.env, 'qualify-lead', { id })
  NOTE: score_icp no longer persists; save_lead writes icp_fit + icp_reasons and merges the 'icp' step verdict.
- OLD: index.js:1219 POST /api/gtm/leads/:id/positions → openRolesForLead(c.env, id) (Nyo tool gtm_open_roles)
  NEW: runWorkflow(c.env, 'company-context', { id })
  NOTE: fetch_open_roles is now a pure fetch — it does not persist on its own. Calling runTool('fetch_open_roles') alone would return the roles without storing them, so the route must go through the workflow (or add reconcile_identity + save_lead behind it).
- OLD: index.js:1228 POST /api/gtm/leads/:id/angles → generateAngles(c.env, id) (Nyo tool gtm_outreach_angles)
  NEW: runWorkflow(c.env, 'draft-outreach-angles', { id })
  NOTE: Still drafts only. The blocked-on-org_status='warn' guard now lives in draft_angles, and save_angles refuses an empty payload so a block cannot wipe stored angles.
- OLD: index.js:1229 POST /api/gtm/leads/:id/angles/save → saveAngles(c.env, id, payload) (Nyo tool gtm_save_angles)
  NEW: runTool(c.env, 'save_angles', { id, payload })
  NOTE: Whole-payload replace, unchanged.
- OLD: index.js:1178 GET /api/gtm/leads/:id → gtmGetLead + listOrgPeople + readAngles + listSends
  NEW: runTool(c.env, 'read_lead', { id }) — plus the Outreach family's sends tool for the `sends` key
  NOTE: read_lead returns {lead(state+confidence), org_people, angles, org_fetched:false}. org_people now comes back in theorg's shape (nodeId/parentId/photo/reportCount) instead of raw gtm_org_people columns — the web UI's lead drawer reads photo_url/report_count today and must be updated with the route.
- OLD: index.js:1220 GET /api/gtm/green → greenLeads + readAnglesMany + contactStatuses (Nyo tool gtm_green_leads)
  NEW: runTool(c.env, 'list_green_leads', {})
  NOTE: Identical payload; the three lib calls now live in greenLeadsWithStatus.
- OLD: index.js:1244 GET /api/gtm/you → readYou(c.env) (Nyo tool gtm_you)
  NEW: runTool(c.env, 'read_you', {})
  NOTE: POST /api/gtm/you (writeYou) has NO v2 tool — the gtm-you doc is edited with write_knowledge. Keep the route on writeYou or retire it.
- OLD: index.js:1254 POST /api/gtm/leads/:id/to-pipeline → promoteLeadToPipeline(c.env, id, 'operator') (Nyo tool gtm_lead_to_pipeline)
  NEW: runTool(c.env, 'promote_lead', { id })
  NOTE: Idempotent in the lib, unchanged.
- OLD: Nyo tool gtm_identity_audit (no route; called with fix:true from chat)
  NEW: runTool(c.env, 'audit_identities', {}) then runWorkflow(c.env, 'clean-identity', { id }) once per reported mismatch
  NOTE: The v2 audit is REPORT-ONLY by design — the fix:true branch is now the clean-identity workflow, one run per lead, so every teardown is auditable in workflow_runs.
- OLD: Nyo tool gtm_api_limits_update (no route)
  NEW: runTool(c.env, 'update_api_limits', {...})
  NOTE: Same lib (gtm-usage saveLimits), which already logs gtm_api_limits_updated.
- OLD: index.js:1138 GET /api/gtm/usage → runTool(c.env, 'gtm_api_usage', {})
  NEW: no replacement in the Prospecting family — keep gtm_api_usage or give it a home
  NOTE: ARCHITECTURE-V2 lists update_api_limits but no read tool for the usage meters, so this route breaks if tools/gtm.js is deleted. Same for the intake surface still on the old file: gtm_import_leads, gtm_list_leads, gtm_update_lead, gtm_enrich_batch, gtm_wa_candidates, gtm_import_from_wa, gtm_check_whatsapp, gtm_enrich_sources have no v2 Prospecting equivalents.
- OLD: chat/index.js:60 (Nyo system prompt) names gtm_import_leads / gtm_enrich_lead / gtm_green_leads / gtm_org_chart / gtm_score_icp / gtm_open_roles / gtm_outreach_angles / gtm_lead_to_pipeline / gtm_you / gtm_check_whatsapp / gtm_enrich_sources
  NEW: rewrite the GTM paragraph around run_workflow('enrich-lead'|'company-context'|'qualify-lead'|'draft-outreach-angles'|'clean-identity') and the granular tool names
  NOTE: Not a runTool call, but the model will keep asking for the retired names until this prompt is updated.

## blog family
tools: list_blog_posts, read_blog_post, save_blog_post, edit_blog_post, delete_blog_post, publish_blog_post, read_voice_profile, draft_article, expand_article, append_faq_schema, draft_figures, render_figures, embed_figures, draft_cover, render_cover, set_featured_image, draft_visual_brief, render_images, judge_images, read_aeo_question, save_aeo_question, draft_interview_questions, save_interview_questions, save_interview_answers, claim_aeo_question, save_aeo_feedback, draft_taste_profile, read_suggestion_policy, draft_suggestion_angles, save_aeo_suggestions
workflows: blog-shape, blog-expand, article-figures, blog-cover, blog-featured-image, social-card, article-from-social, aeo-interview-start, aeo-write, aeo-write-with-answers, aeo-react, aeo-suggestion-generator
route migrations:
- OLD: index.js:554 app.post('/api/blog/:slug/publish') — publishBlogPostToProd(c.env, slug, {source, deploy, ctx})
  NEW: runTool(c.env, 'publish_blog_post', { slug, deploy: body.deploy !== false, actor: body.source || 'operator' })
  NOTE: No runTool call site exists today (the route calls the lib directly). runTool has no executionCtx parameter, so if the route wants the current background behaviour it must keep its own c.executionCtx.waitUntil around the runTool call.
- OLD: index.js:585 app.post('/api/blog/publish-batch') — publishBlogPostsToProd(c.env, slugs, {...})
  NEW: for (const slug of slugs) await runTool(c.env, 'publish_blog_post', { slug, deploy: false }); then one deploy at the end
  NOTE: Or leave on the lib: the batch helper is a loop with a single trailing rebuild, not a tool.
- OLD: index.js:596 app.post('/api/blog/:slug/reshape') — composeAndSavePost(c.env, {slug, title, body, voice, target_keyword, published, published_at, actor})
  NEW: runWorkflow(c.env, 'blog-shape', { slug, title: post.title, body: post.body, voice: body.voice || 'house', target_keyword: body.target_keyword || null, actor: 'operator' })
  NOTE: The route must keep its own readBlogPost first: blog-shape has no read step (it also serves fresh writes). published/published_at are no longer passed — save_blog_post preserves the row's existing publication state by design.
- OLD: index.js:620 app.post('/api/blog/:slug/expand') — expandPostWithFaq(c.env, {slug, voice, actor})
  NEW: runWorkflow(c.env, 'blog-expand', { slug, voice: body.voice || 'house' })
  NOTE: Behaviour note: read_voice_profile defaults to 'house'; pass the personal voice value explicitly only when the operator asks for that overlay.
- OLD: index.js:630 app.post('/api/blog/:slug/generate-image') — regenerateBlogFeaturedImage(c.env, slug, {actor, prompt_override, model})
  NEW: runWorkflow(c.env, 'blog-featured-image', { slug, model: body.model || null, n: body.n || null })
  NOTE: prompt_override has no place in the workflow (draft_visual_brief would overwrite it in the shared context). For that path call the tools directly: render_images({blog_slug, prompt: body.prompt_override, model}) -> judge_images -> set_featured_image.
- OLD: index.js:645 app.post('/api/social-cards/generate') — generateSocialCard(c.env, {slug, title, excerpt, template, slots, actor})
  NEW: runWorkflow(c.env, 'social-card', { slug, title, excerpt, template, slots })
  NOTE: The card tools (draft_card/render_card/save_social_card) belong to the Social family; only the workflow seed lives in blog.js.
- OLD: index.js:850 app.post('/api/aeo/feedback') — recordAeoFeedback(...) + refreshTasteProfile(c.env)
  NEW: runWorkflow(c.env, 'aeo-react', { reaction: body.reaction, note: body.note || null, question_slug: body.slug || null, idea_title: body.idea_title || null })
  NOTE: The workflow ends in the Core write_knowledge tool, so the taste doc update is visible as a workflow run instead of a silent enrichment.
- OLD: index.js:863 app.post('/api/aeo/taste/refresh') — refreshTasteProfile(c.env)
  NEW: const doc = await runTool(c.env, 'draft_taste_profile', {}); if (!doc.skipped) await runTool(c.env, 'write_knowledge', doc);
  NOTE: Acceptable to leave as-is: refreshTasteProfile is now a thin draft-then-write wrapper over the same code.
- OLD: index.js:911 app.post('/api/aeo/draft-now') — runAeoCron(c.env, {actor:'operator-manual'})
  NEW: runWorkflow(c.env, 'aeo-write', {})
  NOTE: BEHAVIOUR CHANGE the orchestrator must handle: runAeoCron used to START an interview when the next question had no answers. claim_aeo_question now refuses instead (fail-closed). The route should catch that refusal and run 'aeo-interview-start' with the same question, which is the v2 split of the old two-in-one behaviour.
- OLD: index.js:916 app.post('/api/aeo/publish-scheduled') — runAeoCron(c.env, {actor:'aeo-cron-local', readyOnly:true})
  NEW: runWorkflow(c.env, 'aeo-write', {})
  NOTE: readyOnly is now the default: claim_aeo_question with no slug claims the next due question whose interview is ready, and never starts an interview.
- OLD: index.js:925 app.post('/api/aeo/write/:slug') — runAeoCronForSlug(c.env, {slug, actor:'operator-release'})
  NEW: runWorkflow(c.env, 'aeo-write', { question_slug: c.req.param('slug') })
  NOTE: runAeoCronForSlug force-reset status to 'pending' before claiming; claim_aeo_question accepts status pending OR failed (a retry) but never 'drafting', so a concurrent run still cannot double-write.
- OLD: index.js:936 app.post('/api/aeo/suggestions/generate') — generateAeoSuggestions(c.env, {limit})
  NEW: runWorkflow(c.env, 'aeo-suggestion-generator', { limit: body?.limit ?? null })
  NOTE: The workflow's list_signals step belongs to the OSINT/signal family and must accept {min_score, limit} off the shared context (read_suggestion_policy emits both).
- OLD: index.js:941 app.post('/api/aeo/suggestions/:id/approve') — approveAeoSuggestion(c.env, id, {actor, ctx})
  NEW: keep the lib call for now; the v2 equivalent is save_aeo_question -> save_interview_questions -> save_interview_answers -> runWorkflow('aeo-write', {question_slug})
  NOTE: The v2 spec lists no approve_aeo_suggestion / reject_aeo_suggestion / list_aeo_suggestions tool in any family, so there is nothing to route to. Flag for the orchestrator: either those three tools are missing from the spec, or these routes stay on lib/aeo-suggestions.js (which is untouched and still works).
- OLD: index.js:946 app.post('/api/aeo/suggestions/:id/reject') — rejectAeoSuggestion(c.env, id, {actor})
  NEW: unchanged — lib/aeo-suggestions.js rejectAeoSuggestion
  NOTE: Same gap as approve: no v2 tool exists for it.
- OLD: index.js:953 app.post('/api/blog/:slug/generate-figures') — generateArticleFigures(c.env, {slug, actor, trigger_kind, replace})
  NEW: runWorkflow(c.env, 'article-figures', { slug })
  NOTE: `replace` is gone: embed_figures always strips the previous run's figures, so every run is a clean regenerate.
- OLD: index.js:965 app.post('/api/blog/:slug/regenerate-figure') — regenerateOneFigure(c.env, {slug, src, instructions, actor})
  NEW: unchanged — keep calling lib/article-figures.js regenerateOneFigure
  NOTE: The per-chart 'Change' button has no tool in the v2 blog family (no regenerate_one_figure in the 30). Flag to the orchestrator as a gap if that UI must survive.
- OLD: index.js:978 app.post('/api/blog/:slug/regenerate-cover') — regenerateCover(c.env, {slug, actor, polish})
  NEW: runWorkflow(c.env, 'blog-cover', { slug })
  NOTE: blog-cover always drafts the cover slots (the old polish:true path). For the free deterministic render (polish:false), call runTool 'render_cover' then 'set_featured_image' directly — render_cover falls back to first-tag + title + excerpt with no LLM.
- OLD: index.js:1023 app.post('/api/blog/batch/generate-figures') — generateArticleFigures per post in the background loop
  NEW: await runWorkflow(c.env, 'article-figures', { slug: p.slug }) inside the same background loop
  NOTE: The batching/parallelism stays in the route: a batch is not a workflow.
- OLD: index.js:2325 handleScheduled daily leg — runAeoCron(env, {actor:'aeo-cron', readyOnly:true})
  NEW: runWorkflow(env, 'aeo-write', {}, { trigger_kind: 'cron' })
  NOTE: The runner writes the workflow_runs row itself, so the hand-rolled logWorkflowRun around this leg can go.
- OLD: index.js:2334 handleScheduled second daily leg — generateAeoSuggestions(env, {})
  NEW: runWorkflow(env, 'aeo-suggestion-generator', {}, { trigger_kind: 'cron' })
  NOTE: Same: drop the manual logWorkflowRun('aeo-suggestion-generator') block, the runner records the run.
- OLD: Nyo tool pool (tools/blog-posts.js, tools/aeo-interview-write.js, tools/aeo-suggestions.js, tools/aeo-feedback-editing.js) — retired fat tools
  NEW: write_blog_post -> workflow blog-shape; reshape_blog_post -> blog-shape with {slug}; expand_blog_post -> blog-expand; regenerate_blog_image -> blog-featured-image; regenerate_blog_cover -> blog-cover; generate_social_card -> social-card; article_from_social_post -> article-from-social; aeo_add_question -> save_aeo_question (create branch); aeo_start_interview -> aeo-interview-start; aeo_write_with_answers -> aeo-write-with-answers; aeo_write_now -> aeo-write; generate_aeo_suggestions -> aeo-suggestion-generator; aeo_react -> aeo-react; aeo_edit_question -> save_aeo_question (patch branch)
  NOTE: list_blog_posts, read_blog_post, edit_blog_post, delete_blog_post and publish_blog_post keep their exact names in tools/blog.js, so the old and new files MUST NOT both be spread into TOOL_REGISTRY. Also: the spec's signal-to-blog workflow references a tool named add_aeo_question that is defined in no family — it is save_aeo_question's create branch.

## social family
tools: list_social_posts, read_social_post, list_social_integrations, draft_social_post, save_social_post, edit_social_post, delete_social_post, approve_social_post, push_social_post, draft_card, render_card, save_social_card
workflows: social-drafts-for-article, social-release-post, social-post-now
route migrations:
- OLD: index.js:1634 runTool(c.env, 'hottake_draft_social', { id, channel, actor }) — POST /api/hot-takes/packages/:id/draft-social
  NEW: runWorkflow(c.env, 'hottake-social-legs', { id, channel? }) — a Hot Takes workflow of read_hottake_package -> read_blog_post -> draft_social_post{channel:'linkedin-company'} -> save_social_post -> draft_social_post{channel:'linkedin-personal'} -> save_social_post
  NOTE: draft_hottake_post no longer exists (referee: use draft_social_post). Both legs are now ordinary social_posts rows with package_id set; save_social_post REPLACES the existing unposted leg for that package+channel, so re-running is the Redraft button. For the single-leg redraft the route already passes (body.channel), the smallest correct wiring is two runTool calls: draft_social_post {package_id:id, channel, post:<blog row>} then save_social_post {package_id:id, channel} — or seed a second one-leg workflow. The chain needs the article fields on the context: read_hottake_package must emit the package's blog_slug so read_blog_post can resolve it.
- OLD: index.js:1654 runTool(c.env, 'hottake_draft_social', { slug, actor }) — POST /api/hot-takes/blog/:slug/draft-social
  NEW: runWorkflow(c.env, 'hottake-social-legs', { slug }) with adopt_blog_draft as its first step (the old tool's ensurePackageForSlug adoption)
  NOTE: Same chain as above; the only difference is that the package is adopted from the slug first. If Hot Takes does not seed that workflow, the fallback for a plain blog draft is the Social workflow itself: runWorkflow(c.env, 'social-drafts-for-article', { slug }) — but that fans out to three channels, not the two LinkedIn legs.
- OLD: index.js:1662 runTool(c.env, 'hottake_post_leg', { post_id, actor }) — POST /api/hot-takes/posts/:postId/send
  NEW: runWorkflow(c.env, 'social-release-post', { id: c.req.param('postId') })
  NOTE: Direct swap. push_social_post supersedes lib/hot-takes.js postLeg: it keeps the hottakes.live dry-run gate (returns {ok:true, dry_run:true, would:{...}} exactly like postLeg did) and adds the outbox claim postLeg never took. ONE behaviour is lost and needs a home: postLeg called maybeComplete() to flip the package to 'complete' once the website + every planned leg was done. Add a Hot Takes step/tool for that (e.g. complete_hottake_package) after push, or derive package status in the read view.
- OLD: index.js:1823 runWorkflow(c.env, 'social-drafts-for-article', { slug, force }) then `const inner = r.results[r.results.length-1].result; return c.json({...inner, run_id})` — POST /api/social/generate/:slug
  NEW: same runWorkflow call, but build the response from the run: `const drafted = r.results.filter(s => s.tool === 'save_social_post' && s.result?.post).length; return c.json({ ok: true, slug, drafted, skipped: r.results.filter(s => s.result?.skipped).length, run_id: r.run_id })`
  NOTE: MUST change with the new steps. The workflow is now 7 steps and its last step is save_social_post, whose result is {post,id} (or {skipped,reason}) — spreading it returns a single post row where the client expects {ok, drafted, skipped, reason}. Same caveat in lib/publish.js:118-128 (generateSocialDrafts): its `inner.ok === false` check can never fire now, so a fan-out that drafted nothing looks successful — switch it to the same per-step count.
- OLD: workflows/runner.js:122-125 RUNNABLE_SEEDS entry ['social-drafts-for-article', ..., [{ tool: 'draft_social_posts' }]]
  NEW: delete that entry; seed from src/workflows/seeds/social.js instead
  NOTE: CRITICAL: seedSystemWorkflows uses INSERT OR IGNORE, so the stale one-step row already in D1 wins forever and the new 7-step definition never lands. The seeding pass must UPDATE steps/description/trigger for existing system-source slugs, not just INSERT OR IGNORE. runner.js:133 also ends the 'hottake-produce' seed with the removed hottake_draft_social — that seed is the Hot Takes family's to re-point.
- OLD: index.js:1779-1812 — /api/social/* routes calling lib functions directly (listSocialPosts, readSocialPost, patchSocialPost, approveAndPush, deleteSocialPost, socialSettings)
  NEW: GET /api/social/posts -> runTool('list_social_posts', {status, slug}); GET /api/social/posts/:id -> runTool('read_social_post', {id}); PUT /api/social/posts/:id -> runTool('edit_social_post', {id, content}); POST /api/social/posts/:id/approve -> runWorkflow('social-release-post', {id}); DELETE /api/social/posts/:id -> runTool('delete_social_post', {id}); GET /api/social/settings -> runTool('list_social_integrations', {})
  NOTE: No runTool today, but these are the module-layer calls that must move onto the new pool. Two gaps with no v2 tool: POST /api/social/posts/:id/skip (lib skipSocialPost) and DELETE /api/social/group/:slug (lib deleteSocialGroup). Since 0062 unified the tables, skip is now covered by the Hot Takes family's save_hottake_post {post_id, status:'skipped'}; the group delete has no tool in the v2 list at all — keep the lib call or add one.
- OLD: index.js:645-666 — POST /api/social-cards/generate and GET /api/social-cards calling generateSocialCard / listSocialCards directly
  NEW: POST /api/social-cards/generate -> runWorkflow('social-card', { slug }) (or, for a custom-title card, runTool('draft_card', {title, excerpt, template, slots}) -> runTool('render_card', ...) -> runTool('save_social_card', ...))
  NOTE: The spec's `social-card` workflow (read_blog_post -> draft_card -> render_card -> save_social_card) was NOT in my three assigned slugs and is in nobody's seed file — three of its four steps are Social tools, the first is Blog's. Assign it to one seed file before wiring this route. GET /api/social-cards has no v2 tool (no list_social_cards in the 12) — leave it on lib listSocialCards.
- OLD: chat/index.js:97-103 SLOW_TOOLS set contains 'draft_social_posts' and 'generate_social_card'; the system prompt at chat/index.js:24 and :54 tells Nyo to use create_social_post / post_to_social
  NEW: SLOW_TOOLS: 'draft_social_post' (the LLM step) and 'draft_card'; prompt: 'save_social_post' for adding a post to the queue, and run the social-post-now workflow (never a direct post tool) for publishing
  NOTE: post_to_social is gone from this family by design — the whole point of social-post-now is that an ad-hoc post takes the same outbox claim. The prompt currently teaches the bypass.

## hottakes family
tools: list_hottake_packages, read_hottake_package, list_topic_feed, pin_hottake_topic, save_hottake_package, adopt_blog_draft, extract_article_meta, draft_hottake_take, build_hottake_brief, build_hottake_seed, link_hottake_article, scan_hottake_article, schedule_hottake_release, cancel_hottake_schedule, list_heartbeat_sources, save_heartbeat_source, delete_heartbeat_source, ingest_signals, score_signals, enrich_signals, list_signals, read_signal, save_signal, synthesize_pulse, read_industry_pulse, synthesize_hot_topics, list_hot_topics, generate_digest, list_osint_listeners, save_osint_listener, list_osint_targets, read_osint_target, save_osint_target, delete_osint_target, scrape_osint_targets, list_osint_mentions
workflows: hottake-add-link, hottake-produce, hourly-awareness-sweep, signal-to-blog
route migrations:
- OLD: index.js:1592  POST /api/hot-takes/add-link → runTool(c.env, 'hottake_add_link', { url: b.url, actor: 'operator' })
  NEW: runWorkflow(c.env, 'hottake-add-link', { url: b.url, actor: 'operator' })
  NOTE: The fetch+extract+pin fat tool is now the 3-step workflow (fetch_web_page → extract_article_meta → pin_hottake_topic). Result shape changes from {package} to the runner envelope — read r.output.package.
- OLD: index.js:1611  POST /api/hot-takes/packages/:id/draft-take → runTool(c.env, 'hottake_draft_take', { id, actor: 'operator' })
  NEW: runTool(c.env, 'draft_hottake_take', { id: c.req.param('id'), actor: 'operator' })
  NOTE: Straight rename; same {package} out.
- OLD: index.js:1615  POST /api/hot-takes/packages/:id/build-brief → runTool(c.env, 'hottake_build_brief', { id, actor: 'operator' })
  NEW: runTool(c.env, 'build_hottake_brief', { id: c.req.param('id'), actor: 'operator' })
  NOTE: Straight rename; same {package} out.
- OLD: index.js:1621  POST /api/hot-takes/packages/:id/write-article → runTool(c.env, 'hottake_write_article', { id, voice, actor: 'operator' })
  NEW: PREFERRED: keep the fat path as a direct lib call — import { writeArticleFromBrief } from './lib/hot-takes.js' and call writeArticleFromBrief(c.env, id, { voice: b.voice, actor: 'operator' }). ALTERNATIVE: runWorkflow(c.env, 'hottake-produce', { id, voice })
  NOTE: There is NO v2 tool for 'write the article only' — the spec dissolved it into hottake-produce (build_hottake_seed → read_voice_profile → list_blog_posts → draft_article → save_blog_post → figures → link_hottake_article). Do NOT point this button at hottake-produce blindly: that workflow starts at draft_hottake_take and would overwrite an already-approved take. Either keep the lib call (routes may call libs, as the other 15 hot-takes routes do) or replace the three spine buttons in the UI with one Produce button on hottake-produce.
- OLD: index.js:1628  POST /api/hot-takes/packages/:id/review-scan → runTool(c.env, 'hottake_review_scan', { id, actor: 'operator' })
  NEW: runTool(c.env, 'scan_hottake_article', { id: c.req.param('id'), actor: 'operator' })
  NOTE: Straight rename; same {package, open_claims, flags} out.
- OLD: index.js:1634  POST /api/hot-takes/packages/:id/draft-social → runTool(c.env, 'hottake_draft_social', { id, channel, actor: 'operator' })
  NEW: Per requested channel (default both linkedin-company + linkedin-personal): const pkg = await runTool(env,'read_hottake_package',{id}); const { post } = await runTool(env,'read_blog_post',{slug: pkg.package.blog_slug}); const d = await runTool(env,'draft_social_post',{channel, title: post.title, url: `${PUBLIC_ORIGIN}/blog/${post.slug}/`, excerpt: post.excerpt, tags: post.tags, body_html: post.body, slug: post.slug}); await runTool(env,'save_social_post',{channel, content: d.content, slug: post.slug, title: post.title, image_url: post.featured_image_url, package_id: id});
  NOTE: draft_hottake_post/save_hottake_post were cut as twins. Use read_blog_post (NOT link_hottake_article) to gather the article fields — link_hottake_article moves the package status back to 'review', which would regress a package already at ready/scheduled. save_social_post MUST persist package_id or the legs are orphaned from the package.
- OLD: index.js:1639  POST /api/hot-takes/packages/:id/schedule → runTool(c.env, 'hottake_schedule_release', { id, ...b, actor: 'operator' })
  NEW: runTool(c.env, 'schedule_hottake_release', { id: c.req.param('id'), ...b, actor: 'operator' })
  NOTE: Straight rename; same {package, posts, article, next_action} out. Still never promotes a leg to 'scheduled' — per-post approval remains the only path to that state.
- OLD: index.js:1643  POST /api/hot-takes/packages/:id/cancel-schedule → runTool(c.env, 'hottake_cancel_schedule', { id, actor: 'operator' })
  NEW: runTool(c.env, 'cancel_hottake_schedule', { id: c.req.param('id'), actor: 'operator' })
  NOTE: Straight rename; still lookup-only, never creates a package.
- OLD: index.js:1650  POST /api/hot-takes/blog/:slug/schedule → runTool(c.env, 'hottake_schedule_release', { slug, ...b, actor: 'operator' })
  NEW: runTool(c.env, 'schedule_hottake_release', { slug: c.req.param('slug'), ...b, actor: 'operator' })
  NOTE: Rename only — the new tool keeps the slug branch (adopts the draft via ensurePackageForSlug before scheduling).
- OLD: index.js:1654  POST /api/hot-takes/blog/:slug/draft-social → runTool(c.env, 'hottake_draft_social', { slug, actor: 'operator' })
  NEW: const { package: pkg } = await runTool(env,'adopt_blog_draft',{ slug }); then the same read_blog_post → draft_social_post → save_social_post pair per channel, passing package_id: pkg.id
  NOTE: adopt_blog_draft replaces the tool's implicit slug→package adoption; the drafting half moves to the Social family.
- OLD: index.js:1658  POST /api/hot-takes/packages/:id/publish-website → runTool(c.env, 'hottake_publish_website', { id, actor: 'operator' })
  NEW: const pkg = await runTool(env,'read_hottake_package',{ id }); const r = await runTool(env,'publish_blog_post',{ slug: pkg.package.blog_slug }); await runTool(env,'save_hottake_package',{ id, status:'published', website_status:'published', website_url: r.url, actor:'operator' });
  NOTE: BEHAVIOUR GAP to close deliberately: lib publishWebsite also mirrored the calendar event and called maybeComplete (flip package → 'complete' once every planned leg is posted). publish_blog_post does neither, so the second call above is mandatory and the auto-complete is lost on this manual path. The cron path is unaffected — POST /api/hot-takes/run-due still calls lib runDueReleases → publishWebsite/postLeg, which keep both behaviours.
- OLD: index.js:1662  POST /api/hot-takes/posts/:postId/send → runTool(c.env, 'hottake_post_leg', { post_id, actor: 'operator' })
  NEW: await runTool(env,'approve_social_post',{ id: c.req.param('postId') }); return runTool(env,'push_social_post',{ id: c.req.param('postId') });
  NOTE: send_hottake_post was cut as a twin. approve_social_post opens the outbox claim that push_social_post requires (claim-then-send stays atomic). NOTE the gate swaps: lib postLeg dry-ran unless the `hottakes.live` flag was true; the Social path uses its own gate. Confirm the operator still gets a dry-run default for LinkedIn legs, or Hot Takes loses its safety flag.

## linkedin family
tools: probe_linkedin, read_linkedin_profile, read_my_linkedin_profile, get_linkedin_feed, list_linkedin_dms, read_linkedin_dm, search_linkedin_people, send_linkedin_dm, send_linkedin_connection, post_linkedin_text, react_linkedin_post
route migrations:
- OLD: index.js:256 (inside GET /api/system/health) — const li = await probeLinkedIn(env);
  NEW: const li = await runTool(env, 'probe_linkedin', {});
  NOTE: Not a runTool call today, it reaches lib/linkedin.js directly. Output is an exact pass-through of the probe blob, so the existing li?.reachable / li?.error reads keep working.
- OLD: index.js:1836 — app.get('/api/li/probe', async (c) => c.json(await probeLinkedIn(c.env)));
  NEW: app.get('/api/li/probe', async (c) => c.json(await runTool(c.env, 'probe_linkedin', {})));
  NOTE: Pass-through shape, no consumer change.
- OLD: index.js:1837-1841 — app.post('/api/li/cookies', ... setLinkedInCookies(c.env, body))
  NEW: KEEP AS IS (direct lib call)
  NOTE: Deliberate: raw li_at / JSESSIONID session cookies are not a tool and have no gateway mode. The 11-tool family does not cover cookie capture; do not invent a tool for it in this pass.
- OLD: index.js:1842 — app.get('/api/li/me', async (c) => safeLi(c, () => liMyProfile(c.env)));
  NEW: app.get('/api/li/me', async (c) => safeLi(c, () => runTool(c.env, 'read_my_linkedin_profile', {})));
  NOTE: Pass-through blob, no consumer change.
- OLD: index.js:1843 — safeLi(c, () => liProfile(c.env, c.req.param('public_id')))
  NEW: safeLi(c, () => runTool(c.env, 'read_linkedin_profile', { public_id: c.req.param('public_id') }))
  NOTE: Pass-through blob, no consumer change.
- OLD: index.js:1844 — safeLi(c, () => liFeed(c.env, { count: parseInt(c.req.query('count') || '20', 10) }))
  NEW: safeLi(c, () => runTool(c.env, 'get_linkedin_feed', { count: parseInt(c.req.query('count') || '20', 10) }))
  NOTE: SHAPE CHANGE: now {items, count} instead of the raw daemon blob (items|posts|elements). No SPA consumer (verified: nothing in web/src calls this route), curl/dev-bench only.
- OLD: index.js:1845 — safeLi(c, () => liConversations(c.env, { limit: parseInt(c.req.query('limit') || '25', 10) }))
  NEW: safeLi(c, () => runTool(c.env, 'list_linkedin_dms', { limit: parseInt(c.req.query('limit') || '25', 10) }))
  NOTE: SHAPE CHANGE: now {conversations, count}. No SPA consumer.
- OLD: index.js:1846-1848 — safeLi(c, () => liConversationMessages(c.env, c.req.param('urn'), { limit: ... }))
  NEW: safeLi(c, () => runTool(c.env, 'read_linkedin_dm', { conversation_urn: c.req.param('urn'), limit: parseInt(c.req.query('limit') || '25', 10) }))
  NOTE: SHAPE CHANGE: now {conversation_urn, messages, count}. No SPA consumer.
- OLD: index.js:1849-1852 — app.post('/api/li/search/people', ... safeLi(c, () => liSearchPeople(c.env, body)))
  NEW: safeLi(c, () => runTool(c.env, 'search_linkedin_people', { keywords: body?.keywords, limit: body?.limit }))
  NOTE: SHAPE CHANGE: now {keywords, results, count}; the daemon's {people:[...]} rows are preserved but each row gains a normalized profile_urn_id / public_id / headline. Do NOT repoint lib/li-outreach.js intakeSearch at this tool: it calls callGateway(env,'linkedin','search') directly and reads data.people, and a tool must never be called from a lib the tools themselves sit above.
- OLD: index.js:1853-1856 — app.post('/api/li/messages/send', ... safeLi(c, () => liSendDm(c.env, body)))
  NEW: safeLi(c, () => runTool(c.env, 'send_linkedin_dm', { profile_urn_id: body?.profile_urn_id, body: body?.body, actor: 'operator' }))
  NOTE: Careful with the name collision: the route's local `body` is the parsed request JSON, the tool's `body` field is the message text. SHAPE CHANGE: now {ok, message_id, outbox_id} instead of the raw daemon blob + outbox_id. Failures still throw (safeLi turns them into a 500), which is the no-false-sent guardrail; do not soften it to ok:false.
- OLD: index.js:1857-1860 — app.post('/api/li/connections/request', ... safeLi(c, () => liConnect(c.env, body)))
  NEW: safeLi(c, () => runTool(c.env, 'send_linkedin_connection', { profile_urn_id: body?.profile_urn_id, note: body?.note, profile_urn: body?.profile_urn, actor: 'operator' }))
  NOTE: SHAPE CHANGE: now {ok, invitation_urn, outbox_id}. profile_urn must keep being forwarded — it is what lets the gateway skip the dead (HTTP 410) profile lookup.
- OLD: index.js:1861-1864 — app.post('/api/li/posts/text', ... safeLi(c, () => liPostText(c.env, body)))
  NEW: safeLi(c, () => runTool(c.env, 'post_linkedin_text', { body: body?.body, visibility: body?.visibility, actor: 'operator' }))
  NOTE: Pass-through: the tool returns postText's full verdict {ok, posted, verified, post_url, outbox_id, note|error} unchanged. This route must never be made to throw on posted:false — 'gateway errored but the post is live' is a real outcome the caller has to see.
- OLD: index.js:1865-1868 — app.post('/api/li/posts/react', ... safeLi(c, () => liReactPost(c.env, body)))
  NEW: safeLi(c, () => runTool(c.env, 'react_linkedin_post', { post_url: body?.post_url, reaction: body?.reaction, actor: 'operator' }))
  NOTE: SHAPE CHANGE: now {ok, post_url, reaction}. Requires the new `react` mode on the linkedin gateway (already added).
- OLD: index.js:76-83 — the `import { probeLinkedIn, setLinkedInCookies, getMyProfile as liMyProfile, ... } from './lib/linkedin.js'` block
  NEW: import { setLinkedInCookies } from './lib/linkedin.js';
  NOTE: After the migrations above, setLinkedInCookies is the only lib/linkedin.js symbol index.js still needs. Trim the rest or the build warns on unused imports.