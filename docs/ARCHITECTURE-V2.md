# nyyon-app — architecture v2: granular tools, outcome workflows

**The contract**

- A **tool** is ONE verb on ONE noun. JSON in, JSON out. It reaches the outside world only through a gateway, and it never calls another tool. It may take one reasoning step through the `llm` gateway (draft this, score that), but it never fetches *and* reasons *and* saves *and* notifies.
- A **workflow** is a linear ordered list of existing tools that produces an outcome. No branching, no logic of its own. The runner threads one JSON context through the steps: each tool reads what it needs and merges its result back.
- Anything tunable (voice, cadence, thresholds, model choice, templates) stays in a **knowledge** doc, never a literal.

**Result: 200 granular tools, 29 workflows.** Today's 246 fat tools collapse into these, and the complex ones become workflows you can see, edit, and re-run.

**Check `[x]` = build it. Unchecked `[ ]` = drop it.** I pre-checked everything; uncheck what you do not want.

Tools marked ⚙️ wrap an atomic library guarantee (claim-then-send, no-duplicate, fail-closed). They look batch-ish on purpose: splitting them would break the guarantee, so the loop stays inside one tool while the decision-making around it lives in the workflow.

---

## Workflows — the outcomes

### `aeo-interview-start`

- [x] **Question queued (or created) with 4 saved interview questions awaiting operator answers.**
  - trigger: on-demand (Nyo)
  - steps: `save_aeo_question` → `draft_interview_questions` → `save_interview_questions`

### `aeo-react`

- [x] **Reaction recorded and the nyyon-editorial-taste knowledge doc refreshed.**
  - trigger: on-demand (Nyo, whenever the operator reacts to an idea)
  - steps: `save_aeo_feedback` → `draft_taste_profile` → `write_knowledge`

### `aeo-suggestion-generator`

- [x] **Up to policy-capped pending aeo_suggestions rows developed from top-scored unconverted OSINT signals; source signals marked actioned so never re-suggested.**
  - trigger: cron (daily)
  - steps: `read_suggestion_policy` → `list_signals` → `draft_suggestion_angles` → `save_aeo_suggestions`

### `aeo-write`

- [x] **A ready (interviewed) AEO question written as a DRAFT article with figures + cover, question marked drafted, operator notified; claim gate blocks un-interviewed or concurrently-claimed questions.**
  - trigger: on-demand or cron (no slug = claim next due ready question)
  - steps: `claim_aeo_question` → `read_aeo_question` → `read_voice_profile` → `list_blog_posts` → `draft_article` → `save_blog_post` → `save_aeo_question` → `draft_figures` → `render_figures` → `embed_figures` → `render_cover` → `set_featured_image` → `notify_operator`

### `aeo-write-with-answers`

- [x] **Operator answers saved then the full aeo-write chain runs, producing the drafted article from their expertise.**
  - trigger: on-demand (Nyo, the moment answers arrive)
  - steps: `save_interview_answers` → `claim_aeo_question` → `read_aeo_question` → `read_voice_profile` → `list_blog_posts` → `draft_article` → `save_blog_post` → `save_aeo_question` → `draft_figures` → `render_figures` → `embed_figures` → `render_cover` → `set_featured_image` → `notify_operator`

### `article-figures`

- [x] **2-5 editorial diagrams regenerated and embedded, cover refreshed and set as featured image.**
  - trigger: on-demand
  - steps: `read_blog_post` → `draft_figures` → `render_figures` → `embed_figures` → `render_cover` → `set_featured_image`

### `article-from-social`

- [x] **A social post expanded into a full article DRAFT via the same shape pipeline.**
  - trigger: on-demand
  - steps: `read_social_post` → `read_voice_profile` → `list_blog_posts` → `draft_article` → `save_blog_post` → `draft_figures` → `render_figures` → `embed_figures` → `render_cover` → `set_featured_image`

### `blog-cover`

- [x] **Reliable code-drawn cover regenerated at a cache-busted URL and set as the featured image.**
  - trigger: on-demand
  - steps: `read_blog_post` → `draft_cover` → `render_cover` → `set_featured_image`

### `blog-expand`

- [x] **Existing post expanded to 1600-2200 words with FAQ + FAQPage JSON-LD, refreshed figures and cover; publish stays a separate operator action.**
  - trigger: on-demand
  - steps: `read_blog_post` → `read_voice_profile` → `expand_article` → `save_blog_post` → `append_faq_schema` → `draft_figures` → `render_figures` → `embed_figures` → `render_cover` → `set_featured_image`

### `blog-featured-image`

- [x] **AI-illustration featured image: brief -> N candidates -> vision judge -> winner set on the post.**
  - trigger: on-demand
  - steps: `read_blog_post` → `draft_visual_brief` → `render_images` → `judge_images` → `set_featured_image`

### `blog-shape`

- [x] **A house-styled DRAFT in Blog > Needs review with 2-5 embedded figures and a code-drawn cover; never published.**
  - trigger: on-demand (Nyo 'write a post' / UI; pass {slug} to reshape in place)
  - steps: `read_voice_profile` → `list_blog_posts` → `draft_article` → `save_blog_post` → `draft_figures` → `render_figures` → `embed_figures` → `render_cover` → `set_featured_image`

### `clean-identity`

- [x] **One mismatched lead cleaned: wrong-person LinkedIn cleared, URL tombstoned so it can never re-attach, a visible conflict recorded, and company/position derived from the wrong profile dropped — pure reuse of the enrichment reconcile+save pair.**
  - trigger: on-demand (per mismatch reported by audit_identities)
  - steps: `read_lead` → `reconcile_identity` → `save_lead`

### `company-context`

- [x] **The company behind a lead cached on the lead — theorg org chart, LinkedIn headcount (the ICP size band), open roles — partial by design: a failed leg is reported by its step verdict, never fatal, and coalesce-never-clobber in save_lead keeps known facts.**
  - trigger: on-demand / UI (Qualification tab, also bulk-looped per lead by the module)
  - steps: `read_lead` → `fetch_org_chart` → `fetch_company_profile` → `fetch_open_roles` → `reconcile_identity` → `save_org_chart` → `save_lead`

### `draft-outreach-angles`

- [x] **Ranked outreach angles + draft WhatsApp bubbles persisted for a GREEN lead, blocked while org_status='warn'; drafts only — sending stays behind the operator-approved send_outreach/schedule_send tools and is never chained here.**
  - trigger: on-demand (Outreach tab / Nyo, GREEN leads only)
  - steps: `read_lead` → `draft_angles` → `save_angles`

### `draft-prospect-reply`

- [x] **A suggested next message lands in context as {draft, source} — verbatim approved bubble, first-touch template, or one LLM-composed reply. Never sends; sending is a separate operator action via send_whatsapp.**
  - trigger: on-demand / UI (the WA tab composer)
  - steps: `read_prospect_thread` → `read_lead_angles` → `read_drafting_rules` → `pick_next_bubble` → `compose_reply`

### `enrich-lead`

- [x] **One lead fully identified in accuracy order with provenance, conflicts, step verdicts, a cached org chart, and an ICP verdict persisted; sources self-skip (PDL when identity known, SERP without a name, ICP without name+company+title) so the chain is linear with no runner branching.**
  - trigger: on-demand / UI (module Intake tab per lead; the batch drain is the module looping this workflow via routes while remaining > 0)
  - steps: `read_lead` → `lookup_wa_identity` → `lookup_company_from_linkedin` → `enrich_person_pdl` → `lookup_line_twilio` → `search_socials_serp` → `fetch_org_chart` → `reconcile_identity` → `score_icp` → `save_lead` → `save_org_chart`

### `hottake-add-link`

- [x] **A pasted article URL becomes a standard Selected Topics card (package at status 'topic').**
  - trigger: on-demand (run_workflow with {url})
  - steps: `web_fetch` → `extract_article_meta` → `pin_hottake_topic`

### `hottake-produce`

- [x] **A selected topic becomes a full package at review: take + brief + article draft (figures + cover) + claim/quality scan + both LinkedIn legs drafted. Nothing publishes; the operator still reviews, approves per-post, and schedules.**
  - trigger: on-demand (run_workflow with {id})
  - steps: `draft_hottake_take` → `build_hottake_brief` → `build_hottake_seed` → `compose_blog_draft` → `render_article_figures` → `generate_featured_image` → `link_hottake_article` → `scan_hottake_article` → `draft_hottake_post` → `draft_hottake_post`

### `hourly-awareness-sweep`

- [x] **Fresh mentions scraped, new signals ingested + scored + content-enriched, the industry-pulse note rebuilt, hot topics synthesized, and the digest regenerated from all channels.**
  - trigger: cron (hourly; runner may stagger legs across :00/:15/:30 slots for subrequest budget — trigger detail, not workflow logic)
  - steps: `scrape_osint_targets` → `ingest_signals` → `score_signals` → `enrich_signals` → `synthesize_pulse` → `synthesize_hot_topics` → `generate_digest`

### `meeting-reminders`

- [x] **WhatsApp self-message lead_minutes before each meeting, guaranteed at-most-once per meeting: the claim step's lib takes the reminded_at lock BEFORE the send step runs, and a failed send fails the run with the claim held (fail-closed, visible in workflow_runs).**
  - trigger: cron (piggybacks the 30s /api/nyo/pending poll via waitUntil; com.nyyon.reminders.plist for headless)
  - steps: `list_due_meetings` → `claim_due_meetings` → `compose_reminder` → `send_whatsapp`

### `outreach-cohort-tick`

- [x] **Every due, approved, cleanly-rendering cohort message is sent within the window/caps; repliers are retired from automation; unrenderable rows fail closed; unapproved rows stay visibly due. Honors the outreach.live flag (dry-run reports would-send).**
  - trigger: cron (also on-demand with {dry_run, force, limit})
  - steps: `list_due_members` → `retire_answered_members` → `render_member_messages` → `gate_member_approvals` → `send_due_messages`

### `outreach-replies-to-pipeline`

- [x] **Everyone who replied to LI or GTM WhatsApp outreach is on the sales board — created at replied_stage or advanced forward only, never duplicated.**
  - trigger: cron hourly :00 (also on-demand)
  - steps: `collect_replies` → `promote_replies`

### `qualify-lead`

- [x] **An ICP verdict (strong/medium/weak + reason/gap tags) grounded in stored company facts, persisted on the lead with a step verdict.**
  - trigger: on-demand (Nyo or Qualification tab, after company-context)
  - steps: `read_lead` → `score_icp` → `save_lead`

### `scheduled-send-tick`

- [x] **Due scheduled sends claimed atomically and delivered exactly once (fail-closed claim in the lib; a second run can never duplicate).**
  - trigger: cron (same tick the cron runs today; also runnable manually)
  - steps: `run_due_sends`

### `signal-to-blog`

- [x] **An industry signal becomes a pending AEO question seeded with the article's real content and angle; the signal is marked actioned.**
  - trigger: on-demand (run_workflow with {signal_id})
  - steps: `read_signal` → `add_aeo_question` → `save_signal`

### `social-card`

- [x] **Brand-locked share-card PNG in R2 + social_cards record (custom-title cards start at draft_card with {title,excerpt} input).**
  - trigger: on-demand
  - steps: `read_blog_post` → `draft_card` → `render_card` → `save_social_card`

### `social-drafts-for-article`

- [x] **Three draft rows (one per channel) in the Social review queue; nothing published.**
  - trigger: event (blog publish via publish.js) + on-demand {slug, force?}
  - steps: `read_blog_post` → `draft_social_post` → `save_social_post` → `draft_social_post` → `save_social_post` → `draft_social_post` → `save_social_post`

### `social-post-now`

- [x] **An ad-hoc post published to ONE connection through the same claim path (upgrade: old post_to_social bypassed the outbox); cross-post = one run per connection.**
  - trigger: on-demand from chat with {channel, content, image_url, title?}, only after explicit operator confirmation
  - steps: `save_social_post` → `approve_social_post` → `push_social_post`

### `social-release-post`

- [x] **One approved post sent through its connection under the outbox no-duplicate claim; row flipped posted/failed with full audit trail.**
  - trigger: UI (Social page Approve button) / on-demand {id} — the operator action IS the gate
  - steps: `approve_social_post` → `push_social_post`

---

## Tools — one job each

### Core (knowledge · activity · flags · workflows · calendar · web · chat) (30)

- [x] `check_health` — Check every dependent service's health (worker, WA gateway+session, GTM gateways/keys). · via `wa`
  - `in:` {}
  - `out:` {nyyon_worker, whatsapp_gateway, wa_session, gtm_theorg, gtm_enrichment_keys}
- [x] `claim_due_meetings` ⚙️ — Claim reminder locks on due meetings.
  - `in:` {due_meetings[]} (from shared ctx)
  - `out:` {claimed_meetings:[...]} — lib does atomic UPDATE…WHERE reminded_at IS NULL per row; unclaimed rows are dropped, so a concurrent run can never double-
- [x] `compose_reminder` — Compose the reminder message.
  - `in:` {claimed_meetings[],chatId} (from shared ctx)
  - `out:` {chatId,text} — deterministic template (title/time/location/attendees/notes/link), one combined message for all claimed meetings; {text:null} when non
- [x] `delete_calendar_event` — Delete a calendar event.
  - `in:` {id}
  - `out:` {ok} (prefer status=cancelled)
- [x] `delete_conversation` — Delete a past conversation.
  - `in:` {id}
  - `out:` {ok} (refuses the active conversation; operator-confirmed)
- [x] `delete_knowledge` — Delete a knowledge doc.
  - `in:` {slug}
  - `out:` {ok}
- [x] `delete_workflow` — Delete a workflow.
  - `in:` {slug}
  - `out:` {ok} (refuses source=system)
- [x] `fetch_web_page` — Fetch a web page's readable text. · via `web`
  - `in:` {url,max_chars?:12000}
  - `out:` {url,status,truncated,content}
- [x] `list_calendar_events` — List calendar events.
  - `in:` {from?,to? (ms epoch),kind?,source?,limit?}
  - `out:` {events:[...] asc by starts_at}
- [x] `list_conversations` — List past conversations.
  - `in:` {limit?,offset?}
  - `out:` {conversations:[{id,title,message_count,timestamps}]}
- [x] `list_due_meetings` — List due unreminded meetings.
  - `in:` {hours?} (policy: lead_minutes/kinds/chat from the meeting-reminders knowledge doc)
  - `out:` {due_meetings:[calendar_events rows],chatId,lead_minutes}
- [x] `list_events` — List activity-log events.
  - `in:` {limit?:12 (max 25)}
  - `out:` {events:[{id,kind,actor,created_at,payload≤180ch}]}
- [x] `list_feature_flags` — List feature flags.
  - `in:` {}
  - `out:` {flags:[{key,value,scope}]}
- [x] `list_knowledge` — List knowledge docs.
  - `in:` {scope?,module?}
  - `out:` {docs:[{slug,title,scope}]}
- [x] `list_workflow_runs` — List workflow runs.
  - `in:` {workflow_slug?,status?,limit?}
  - `out:` {runs:[...]}
- [x] `list_workflows` — List workflow definitions.
  - `in:` {source?,status?}
  - `out:` {workflows:[...]}
- [x] `log_note` — Append an activity note.
  - `in:` {text}
  - `out:` {ok}
- [x] `notify_operator` — Queue one Nyo message to the operator.
  - `in:` {kind, content, ref_kind?, ref_id?, payload?}
  - `out:` {ok, queued:true}
- [x] `read_calendar_event` — Read one calendar event.
  - `in:` {id:"ce_…"}
  - `out:` {found,event}
- [x] `read_conversation` — Read one conversation.
  - `in:` {id}
  - `out:` {conversation:{turns[],tools_ran}}
- [x] `read_knowledge` — Read one knowledge doc.
  - `in:` {slug}
  - `out:` {found,doc:{slug,title,body,parent_slug}}
- [x] `read_knowledge_path` — Read a doc's breadcrumb chain.
  - `in:` {slug}
  - `out:` {path:[docs root→leaf]}
- [x] `read_registry` — Read the live system registry (gateways, tools, workflows, knowledge deps).
  - `in:` {}
  - `out:` {gateways[], tools{}, workflows[], knowledge[]}
- [x] `read_workflow` — Read one workflow.
  - `in:` {slug}
  - `out:` {found,workflow:{trigger,steps,meta}}
- [x] `rename_conversation` — Rename a conversation.
  - `in:` {id,title}
  - `out:` {ok}
- [x] `run_workflow` — Run a stored workflow.
  - `in:` {slug,input?}
  - `out:` {ok,run_id,results[]} (audit in workflow_runs + workflow_step_runs)
- [x] `set_feature_flag` — Set a feature flag.
  - `in:` {key,value:boolean}
  - `out:` {ok}
- [x] `write_calendar_event` — Write a calendar event.
  - `in:` {id?,kind,title,starts_at,ends_at?,all_day?,status?,location?,attendees?,body?,link_url?,platform?}
  - `out:` {event}
- [x] `write_knowledge` — Write a knowledge doc.
  - `in:` {slug,title,body,scope?,module?,parent_slug?}
  - `out:` {doc}
- [x] `write_workflow` — Write a workflow definition.
  - `in:` {slug,name,trigger,steps:["tool"|{tool,input}],description?,status?}
  - `out:` {ok,workflow} (steps validated against the live tool pool)

### Daily Planner (7)

- [x] `list_recent_plans` — List recent past plans.
  - `in:` {days?:3}
  - `out:` {plans:[...]}
- [x] `read_daily_plan` — Read one day's plan.
  - `in:` {date?:"YYYY-MM-DD"}
  - `out:` {plan:{mode,summary,schedule[],todos[]}|null}
- [x] `read_weekly_objectives` — Read a week's objectives.
  - `in:` {week_start?:"YYYY-MM-DD Sunday"}
  - `out:` {objectives:[...]}
- [x] `save_daily_plan` — Save a day's plan.
  - `in:` {date?,mode?,summary?,weekly_ref?,schedule:[{start,end,title,deliverable,focus}],todos?:[{text,priority,star}]}
  - `out:` {plan}
- [x] `search_daily_plans` — Search past plans.
  - `in:` {query?,limit?}
  - `out:` {plans:[...]}
- [x] `set_weekly_objectives` — Set a week's objectives.
  - `in:` {objectives:[string|{text}],week_start?}
  - `out:` {objectives}
- [x] `update_daily_plan` — Patch a day's plan.
  - `in:` {date?, ...partial plan keys}
  - `out:` {plan}

### WhatsApp (shared gateway surface) (12)

- [x] `backfill_lid_map` — Resolve @lid privacy chats to phone numbers and cache them. · via `wa`
  - `in:` {limit?}
  - `out:` {pending, resolved}
- [x] `backfill_wa_messages` — Backfill cached gateway messages into the local wa_messages table (deduped on waMessageId). · via `wa`
  - `in:` {limit?, chatId?}
  - `out:` {inserted, skipped}
- [x] `find_wa_chat` — Find a chat/person by partial name or phone (CRM-joined ranking).
  - `in:` {query, limit?}
  - `out:` {query, matches[]}
- [x] `list_wa_chats` — List WhatsApp chats from the local DB with filters.
  - `in:` {listening_only?, not_listening_only?, name_contains?, with_messages_only?, limit?}
  - `out:` {chats[], total_in_db, total_listening}
- [x] `list_wa_groups` — List WhatsApp groups (live gateway, DB fallback). · via `wa`
  - `in:` {}
  - `out:` {groups[], source}
- [x] `react_whatsapp` — React to a WhatsApp message with an emoji. · via `wa`
  - `in:` {messageId, reaction}
  - `out:` {ok}
- [x] `read_group_participants` — Read a WhatsApp group's participant roster. · via `wa`
  - `in:` {groupId}
  - `out:` {participants[]}
- [x] `restart_wa_session` — Restart the WhatsApp session and poll until ready. · via `wa`
  - `in:` {}
  - `out:` {status}
- [x] `send_whatsapp` — Send a WhatsApp text message (outbox-audited in lib). · via `wa`
  - `in:` {chatId, text}
  - `out:` {messageId, timestamp, chatId, outbox_id}
- [x] `send_whatsapp_document` — Send a document to a WhatsApp chat. · via `wa`
  - `in:` {chatId, url, filename, mimetype?}
  - `out:` {messageId, chatId, outbox_id}
- [x] `send_whatsapp_image` — Send an image to a WhatsApp chat. · via `wa`
  - `in:` {chatId, url, caption?}
  - `out:` {messageId, chatId, outbox_id}
- [x] `set_chat_listening` — Set the digest listener flag on one chat, by chat_id or name_match (ambiguous match returns candidates, changes nothing).
  - `in:` {chat_id? | name_match?, listening}
  - `out:` {ok, chat} | {ambiguous, candidates[]}

### Outreach (conversations · cohorts · scheduled sends) (41)

- [x] `approve_message` — Approve (or withdraw approval of) the next message per member; per-message, lapses on send.
  - `in:` {lead_ids[], approve?}
  - `out:` {approved[], refused[]}
- [x] `cancel_scheduled_send` — Cancel a live scheduled send or dismiss a terminal failed/partial one.
  - `in:` {schedule_id}
  - `out:` {cancelled|dismissed}
- [x] `collect_replies` ⚙️ — Collect everyone who replied to LI or GTM WhatsApp outreach, normalized.
  - `in:` {}
  - `out:` {replies[], counts}
- [x] `compose_reply` — Compose one reply draft via a single LLM step; passthrough no-op when ctx already holds a draft. · via `llm`
  - `in:` ctx: {draft?, messages[], prospect, angles[], rules}
  - `out:` {draft, source:'llm'}
- [x] `create_cohort` — Create a cohort (idempotent by name).
  - `in:` {name, note?}
  - `out:` {cohort, created}
- [x] `delete_cohort` — Delete an empty cohort.
  - `in:` {cohort_id}
  - `out:` {deleted, cohort_id}
- [x] `draft_step_copy` — Draft one sequence step's copy via a single LLM step; never saves, never sends. · via `llm`
  - `in:` {cohort_id, step_index?, language?, instruction?}
  - `out:` {draft, step_index, based_on}
- [x] `enroll_members` ⚙️ — Stage prospects into a cohort (batch or single; conflict/override anti-spam rule in lib; never schedules).
  - `in:` {lead_ids[], cohort_id?, override?}
  - `out:` {added[], conflicts[], skipped[]}
- [x] `gate_member_approvals` ⚙️ — Hold back any sendable message the operator has not approved for its exact step (require_approval); held rows stay due and visible.
  - `in:` ctx: {sendable[], dry_run}
  - `out:` {sendable[] (approved only), awaiting[]}
- [x] `launch_members` ⚙️ — Schedule staged members to start their sequence (the ONLY staged-to-scheduled transition; refuses unrenderable sequences).
  - `in:` {lead_ids[], start_at?}
  - `out:` {live[], blocked[], requested}
- [x] `list_cohort_members` — List enrolled members with rendered next message, approval and conversation state.
  - `in:` {status?, cohort_id?}
  - `out:` {members[], cohorts[], counts, live}
- [x] `list_cohorts` — List the named outreach cohorts.
  - `in:` {}
  - `out:` {cohorts[]}
- [x] `list_due_members` — List due active members inside the sending window with daily budget and live/dry-run flag.
  - `in:` {force?, limit?, dry_run?}
  - `out:` {due[], budget, dry_run, awaiting_approval, ran, reason?}
- [x] `list_prospect_threads` — List prospect WhatsApp conversations.
  - `in:` {q?, status?, limit?}
  - `out:` {threads[], counts, total}
- [x] `list_scheduled_sends` — List scheduled sends with the schedule defaults.
  - `in:` {lead_id?,include_done?}
  - `out:` {schedules[],defaults}
- [x] `mark_thread_dead` — Mark one conversation dead (dead:false revives).
  - `in:` {lead_id, dead?, reason?}
  - `out:` {lead_id, dead, reason}
- [x] `override_message` — Override one member's next message text (clear:true restores cohort copy; lib withdraws approval).
  - `in:` {lead_id, text?, clear?}
  - `out:` {lead_id, step, text? | cleared}
- [x] `pause_member` — Pause or resume one member's ladder (resume refused if they replied).
  - `in:` {lead_id, paused}
  - `out:` {lead_id, status}
- [x] `pick_next_bubble` — Pick the next approved bubble (or first-touch template) for an unanswered prospect; deterministic, no model.
  - `in:` ctx: {lead_id, messages[], answered, angles[]}
  - `out:` {draft?, source:'angle'|'template'|'none', step?, alternatives?[]} | {needs_compose:true}
- [x] `promote_replies` ⚙️ — Promote replies onto the sales pipeline (create or advance forward, never backward, never duplicate; matching in lib).
  - `in:` ctx: {replies[]}
  - `out:` {created, advanced, unchanged, skipped, details[]}
- [x] `read_cadence` — Read the cohort cadence rules.
  - `in:` {}
  - `out:` {cadence, source}
- [x] `read_drafting_rules` — Read the reply-drafting rules.
  - `in:` {}
  - `out:` {rules, limits}
- [x] `read_lead_angles` — Read a lead's saved outreach angles.
  - `in:` {lead_id}
  - `out:` {angles[]}
- [x] `read_promotion_rules` — Read the replies-to-pipeline rules.
  - `in:` {}
  - `out:` {replied_stage, advance_only, stage_rank[], tag}
- [x] `read_prospect_thread` — Read one prospect conversation.
  - `in:` {chat_id? | lead_id?, limit?}
  - `out:` {chat_id, chat_ids[], prospect, messages[], stats}
- [x] `read_sequence` — Read a cohort's message sequence.
  - `in:` {cohort_id}
  - `out:` {cohort_id, sequence, unknown_variables[]}
- [x] `remove_member` — Remove one member from the cohort entirely.
  - `in:` {lead_id, reason?}
  - `out:` {removed, lead_id}
- [x] `render_member_messages` ⚙️ — Render each due member's next message (cohort copy or override); fail-closed: stops rows that cannot render cleanly.
  - `in:` ctx: {due[]}
  - `out:` {sendable[{lead_id,chat_id,step,text}], blocked[]}
- [x] `reschedule_member` — Move one member's next send time (approval untouched; staged member gets go-live guard).
  - `in:` {lead_id, send_at}
  - `out:` {lead_id, next_send_at, went_live, outside_window}
- [x] `retire_answered_members` ⚙️ — Retire any due member whose live thread shows a reply (runs on ALL due rows, approved or not).
  - `in:` ctx: {due[]}
  - `out:` {due[] (filtered), retired[]}
- [x] `run_due_sends` ⚙️ — Run the scheduled-send tick (atomic one-shot claim then send; fail-closed, repeat-safe, can never duplicate). · via `whatsapp`
  - `in:` {}
  - `out:` {claimed,sent,failed}
- [x] `save_cadence` — Save the cohort cadence rules (incl. require_approval master gate).
  - `in:` {step_delays_hours?, max_sends_per_day?, min_gap_minutes?, quiet_start_hour?, quiet_end_hour?, weekdays_only?, timezone?, dead_after_days?, require_ap
  - `out:` {cadence}
- [x] `save_drafting_rules` — Save the reply-drafting rules.
  - `in:` {rules?, limits?}
  - `out:` {rules, limits}
- [x] `save_promotion_rules` — Save the replies-to-pipeline rules.
  - `in:` {replied_stage?, advance_only?, stage_rank?, tag?}
  - `out:` {replied_stage, advance_only, stage_rank[], tag}
- [x] `save_sequence` — Save a cohort's message sequence (lib withdraws affected approvals per scope).
  - `in:` {cohort_id, sequence, scope?}
  - `out:` {ok, edits_replaced, approvals_withdrawn}
- [x] `schedule_send` — Schedule outreach bubbles for a future time (lib guards: identical-content-ever-sent refused, one live schedule per lead+content, never early, never twice). · via `none`
  - `in:` {id,bubbles[],send_at}
  - `out:` {schedule_id,send_at}
- [x] `send_due_messages` ⚙️ — Send the approved due messages within budget and pacing; lib atomically re-verifies answered in the moment before each send, advances step with the send, and fail-closes (stops, never re-arms) on any error; dry_run reports would-send. · via `wa`
  - `in:` ctx: {sendable[], budget, dry_run}
  - `out:` {sent, results[], dry_run}
- [x] `send_outreach` ⚙️ — Send approved outreach bubbles to a lead's WhatsApp, humanly paced (lib guards: max 4 bubbles, 4-9s jitter, stop-on-first-failure, 10-min repeat refusal unless force, all logged; operator shows bubbles + gets explicit yes first). · via `whatsapp`
  - `in:` {id,bubbles[],force?}
  - `out:` {sent[],failed?,stopped_at?}
- [x] `stop_member` — Stop one member's ladder (terminal but visible).
  - `in:` {lead_id}
  - `out:` {lead_id, status:'stopped'}
- [x] `unschedule_member` — Return one member to a draft: keeps place and approval, clears send time.
  - `in:` {lead_id}
  - `out:` {lead_id, status:'staged'}
- [x] `update_cohort` — Update a cohort's settings/status (status gates the sender).
  - `in:` {cohort_id, name?, status?, timezone?, start_hour?, end_hour?, send_days?, send_windows?, languages?}
  - `out:` {ok, cohort_id, ...changed}

### Prospecting (lead enrichment) (20)

- [x] `audit_identities` — Audit every lead's assigned LinkedIn against their name and report match/unverifiable/mismatch (report-only; fixing runs the clean-identity workflow per lead). · via `none`
  - `in:` {}
  - `out:` {checked,match,unverifiable,mismatch:[{id,name,linkedin,company}]}
- [x] `draft_angles` — Draft ranked outreach angles and WhatsApp bubbles for a GREEN lead from the gtm-you/playbook/rules/examples docs and the verified org chart (fail-closed while org_status='warn'; a draft, never a send). · via `llm`
  - `in:` ctx {lead,org_people}
  - `out:` {angles_payload:{angles:[{rank,angle,bubbles[]}]}}
- [x] `enrich_person_pdl` — Enrich a phone-anchored person via People Data Labs (self-skips when name+company already in ctx — PDL is paid). · via `pdl`
  - `in:` {phone,name?,region?,country?}
  - `out:` {matched,likelihood,pdl_name,pdl_company,pdl_title,pdl_email,pdl_profiles[]} | {skipped}
- [x] `fetch_company_profile` — Resolve a company's LinkedIn profile (id, headcount, canonical page). · via `linkedin`
  - `in:` {company|company_linkedin_url}
  - `out:` {company_id,staff_count,company_name,company_url}
- [x] `fetch_open_roles` — Fetch a company's open roles from LinkedIn's guest jobs API. · via `linkedin`
  - `in:` {company_id}
  - `out:` {positions:[{title,location,url}],count}
- [x] `fetch_org_chart` — Fetch a company's org chart from theorg.com. · via `theorg`
  - `in:` {company|theorg_slug} (from ctx lead or li_company/pdl_company)
  - `out:` {org_company,org_people:[{nodeId,parentId,name,role,photo,reportCount}]} | {error}
- [x] `list_green_leads` — List fully-identified GREEN leads with warm-contact flags, stored angles, and contact_status.
  - `in:` {}
  - `out:` {leads:[{...,has_contact,contacts,angles,contact_status,replied_at?}]}
- [x] `lookup_company_from_linkedin` — Read the person's current company and title off their name-verified LinkedIn search result. · via `serp`
  - `in:` {name,linkedin?} (from ctx lead/wa_name)
  - `out:` {li_company,li_position,li_profile_url,li_rejected:[{url,verdict}]}
- [x] `lookup_line_twilio` — Look up a phone number's line type, carrier, and CNAM name. · via `twilio`
  - `in:` {phone}
  - `out:` {valid,line_type,carrier,caller_name}
- [x] `lookup_wa_identity` — Look up a phone number's WhatsApp identity. · via `whatsapp`
  - `in:` {phone} (or lead.phone from ctx)
  - `out:` {on_whatsapp,wa_name,wa_photo_url,wa_about,is_business}
- [x] `promote_lead` — Promote a GTM lead into the Pipeline CRM as a linked contact + client at stage 'target' (idempotent in the lib). · via `none`
  - `in:` {id}
  - `out:` {client_id,contact_id,existing?}
- [x] `read_lead` — Read one GTM lead row with derived state and confidence.
  - `in:` {id}
  - `out:` {lead:{id,phone,name,company,position,linkedin,socials,sources,conflicts,dismissed,org_status,state,confidence}}
- [x] `read_you` — Read the GTM operator profile from the gtm-you knowledge doc. · via `none`
  - `in:` {}
  - `out:` {you:{name,role,business,location,groups,connections}}
- [x] `reconcile_identity` — Reconcile all raw source results in ctx into one provenance-aware lead patch (fill-don't-overwrite precedence, slug/title LinkedIn verification with namesake rejection, tombstone respect, conflict list, CEO-mismatch org warn, per-step verdicts). · via `none`
  - `in:` ctx {lead,wa_*,li_*,pdl_*,line_type,socials,linkedin_candidates,org_people?}
  - `out:` {lead_patch,sources,conflicts,dismissed,steps,org_status,org_note}
- [x] `save_angles` — Persist an outreach-angles payload for a lead (whole-payload replace; drafts stay drafts until the operator sends).
  - `in:` {id,payload}
  - `out:` {ok}
- [x] `save_lead` — Persist a lead patch to gtm_leads through the provenance lib (mergeSources/mergeConflicts, coalesce-never-clobber, tombstones, status='enriched' = attempted) and log the activity event. · via `none`
  - `in:` {id,lead_patch,sources?,conflicts?,steps?,icp_fit?}
  - `out:` {lead:{...state}}
- [x] `save_org_chart` — Persist fetched org people for a lead (replace gtm_org_people rows, localize photos to R2, stamp org_status/org_note/theorg_slug). · via `web`
  - `in:` {id,org_company,org_people,org_status?,org_note?}
  - `out:` {saved,people_count,status}
- [x] `score_icp` — Score a lead against the editable brand-icp knowledge doc using its real company facts. · via `llm`
  - `in:` ctx {lead,org_people?,staff_count?,positions?}
  - `out:` {icp_fit:strong|medium|weak,icp_reasons[],icp_gaps[]} | {error:'needs name+company+title'}
- [x] `search_socials_serp` — Search the web for a named person's social profiles (hard-gated on a sourced name; returns LinkedIn results as unattached candidates with titles). · via `serp`
  - `in:` {name,region?,country?}
  - `out:` {socials:[{type,url}],linkedin_candidates:[{url,title}],query}
- [x] `update_api_limits` — Patch the gtm-api-limits knowledge doc with validated per-provider caps/renewal/warn settings. · via `none`
  - `in:` {pdl?,serpapi?,twilio?}
  - `out:` {limits}

### Blog + article engine (30)

- [x] `append_faq_schema` — Append one FAQPage JSON-LD block to a post body.
  - `in:` {blog_slug, faq}
  - `out:` {ok, faq_count}
- [x] `claim_aeo_question` — Atomically claim one AEO question for writing (pending->drafting; throws if already claimed or interview not ready; no slug = next due ready question).
  - `in:` {question_slug?}
  - `out:` {question_slug, claimed:true}
- [x] `delete_blog_post` — Delete one blog post by slug.
  - `in:` {slug}
  - `out:` {ok, slug}
- [x] `draft_article` — Draft one article in house HTML (one LLM step; reads playbook + dedup titles + tag taxonomy from context). · via `llm`
  - `in:` {title, body?, voice_doc, posts, target_keyword?, expert_context?}
  - `out:` {article:{slug,title,excerpt,body_html,tags}}
- [x] `draft_cover` — Draft cover slots for one post (one cheap LLM step). · via `llm`
  - `in:` {title, excerpt}
  - `out:` {cover:{kicker,highlight,sub}}
- [x] `draft_figures` — Draft figure specs for one article (one LLM step; reads template menu + chart-selection + brand-voice knowledge). · via `llm`
  - `in:` {blog_slug, title, excerpt, body}
  - `out:` {specs:[{template,anchor,featured,alt,slots}], cover:{kicker,highlight,sub}}
- [x] `draft_interview_questions` — Draft 4 expert-interview questions for one topic (one LLM step; taste-aware). · via `llm`
  - `in:` {question_slug, question, target_keyword?, notes?}
  - `out:` {interview_questions:[4]}
- [x] `draft_suggestion_angles` — Draft Nyyon article angles for scored signals (one LLM step; reads voice + playbook + existing titles for dedup). · via `llm`
  - `in:` {signals, limit}
  - `out:` {suggestions:[{signal_id,title,target_keyword,angle,rationale}]}
- [x] `draft_taste_profile` — Draft the updated editorial-taste doc from recent reactions (one LLM step; no writes). · via `llm`
  - `in:` {}
  - `out:` {slug:'nyyon-editorial-taste', title, body}
- [x] `draft_visual_brief` — Draft one AI-image visual brief (one LLM step; reads nyyon-visual-style knowledge). · via `llm`
  - `in:` {title, excerpt, tags?}
  - `out:` {scene, label, prompt}
- [x] `edit_blog_post` — Patch one blog post (field merge or find/replace).
  - `in:` {slug, title?, excerpt?, body?|find+replace?, tags?, published?}
  - `out:` {ok, post:{slug,title,published}, note}
- [x] `embed_figures` — Embed rendered figures into a post body at their anchor sentences.
  - `in:` {blog_slug, figures}
  - `out:` {ok, placed}
- [x] `expand_article` — Expand one article to 1600-2200 words with an AEO FAQ (one LLM step). · via `llm`
  - `in:` {post, voice_doc}
  - `out:` {article:{excerpt,body_html,faq:[{q,a}]}}
- [x] `judge_images` ⚙️ — Judge candidate images against the style doc (one vision-LLM step). · via `llm`
  - `in:` {candidates, title}
  - `out:` {winner_url, winner_index, scores, reasoning}
- [x] `list_blog_posts` — List blog post stubs.
  - `in:` {limit?, published_only?}
  - `out:` {posts:[{slug,title,excerpt,published_at}]}
- [x] `publish_blog_post` ⚙️ — Publish one blog post live (outbox-claimed, edge-verified, IndexNow-announced). · via `web`
  - `in:` {slug, deploy?}
  - `out:` {ok, slug, live, url, edge, indexnow, outbox_id}
- [x] `read_aeo_question` — Read one AEO question with its formatted expert context.
  - `in:` {question_slug}
  - `out:` {question, expert_context, interview_status}
- [x] `read_blog_post` — Read one blog post by slug.
  - `in:` {slug}
  - `out:` {found, post:{slug,title,excerpt,body,tags,published,published_at,featured_image_url}}
- [x] `read_suggestion_policy` — Read the aeo-suggestion-policy doc with current room (pending count vs max_pending).
  - `in:` {limit?}
  - `out:` {policy:{daily_limit,max_pending,min_content_score}, pending_count, room, min_score:(policy floor), limit:(effective)}
- [x] `read_voice_profile` — Read the assembled voice profile (brand voice + learned taste + optional lev overlay).
  - `in:` {voice?:'house'|'lev'}
  - `out:` {voice_doc}
- [x] `render_cover` — Render one code-drawn cover PNG to R2 (deterministic slot fallback from title/excerpt). · via `image`
  - `in:` {blog_slug, title, excerpt, cover?}
  - `out:` {cover_url, cover_key}
- [x] `render_figures` — Render figure specs to stored PNGs (SVG templates -> resvg -> R2). · via `image`
  - `in:` {blog_slug, specs}
  - `out:` {figures:[{template,url,key,anchor,featured,alt}]}
- [x] `render_images` ⚙️ — Render N candidate AI images and store them (bytes never enter context). · via `image`
  - `in:` {blog_slug, prompt, n?, model?}
  - `out:` {candidates:[{url,key,model,seed}]}
- [x] `save_aeo_feedback` — Save one editorial reaction (love/like/meh/reject/edit + note).
  - `in:` {question_slug?|idea_title?, reaction, note?}
  - `out:` {ok, recorded:true}
- [x] `save_aeo_question` — Save one AEO question (create/patch: title, keyword, priority, notes, voice, status, blog link).
  - `in:` {question_slug?, question?, target_keyword?, priority?, notes?, voice?, status?, blog_slug?}
  - `out:` {question_slug, question}
- [x] `save_aeo_suggestions` — Save pending aeo_suggestions rows (skips already-suggested signals, marks sources actioned).
  - `in:` {suggestions, limit}
  - `out:` {ok, created, ids}
- [x] `save_blog_post` — Save one blog post row (unique slug; drafts only, never publishes).
  - `in:` {article, slug?, published?, published_at?, actor?}
  - `out:` {blog_slug, post}
- [x] `save_interview_answers` — Save operator answers on one AEO question (interview_status=ready).
  - `in:` {question_slug, answers}
  - `out:` {ok}
- [x] `save_interview_questions` — Save interview questions on one AEO question (interview_status=pending).
  - `in:` {question_slug, interview_questions}
  - `out:` {ok}
- [x] `set_featured_image` — Set one post's featured-image fields.
  - `in:` {blog_slug, url:(cover_url|winner_url), model?, prompt?}
  - `out:` {ok}

### Social (12)

- [x] `approve_social_post` — Approve one draft for release: refuse if already posted, resolve the CURRENT cover image over the stale row value, and open the outbox send claim. · via `none`
  - `in:` {id}
  - `out:` {id, channel, content, image_url, image_title, outbox_id}
- [x] `delete_social_post` — Delete one social post from the queue by id.
  - `in:` {id}
  - `out:` {ok, id}
- [x] `draft_card` — Draft one social-card template pick + slot text (one LLM step). · via `llm`
  - `in:` {title, excerpt, tags?, template?, slots?}
  - `out:` {template, slots}
- [x] `draft_social_post` — Draft one channel's post text in that channel's voice (brand or Lev) with the style-rule hard constraints, for a blog article or news item. · via `llm`
  - `in:` {channel, title, url, excerpt?, tags?, body_html?, source_kind?('blog'|'news'), slug?, force?}
  - `out:` {channel, content} | {channel, skipped:true, reason}
- [x] `edit_social_post` — Replace a queued post's content with a full new version (edit only, never publishes).
  - `in:` {id, content}
  - `out:` {post}
- [x] `list_social_integrations` — List the social connections (linkedin-company, linkedin-personal, facebook-company) and whether each is configured. · via `none`
  - `in:` {}
  - `out:` {connections:[{connection, label, network, configured}]}
- [x] `list_social_posts` — List queued social posts, filterable by status or source slug.
  - `in:` {status?, slug?}
  - `out:` {posts:[{id, channel, status, blog_slug, blog_title, content, image_url}]}
- [x] `push_social_post` ⚙️ — Send one CLAIMED post through its channel's Make-webhook connection. · via `social`
  - `in:` {id} (requires the open outbox claim from approve_social_post; refuses unclaimed/already-posted; refuses missing image_url before calling Make)
  - `out:` {ok, id, channel, outbox_id, error?}
- [x] `read_social_post` — Read one social post by id.
  - `in:` {id}
  - `out:` {found, post?}
- [x] `render_card` — Render one social card PNG to R2 (fixed brand SVG templates). · via `image`
  - `in:` {blog_slug?, template, slots}
  - `out:` {card:{url,key,template,width,height,size_bytes}}
- [x] `save_social_card` — Save one social_cards record.
  - `in:` {card, blog_slug?, slots, actor?}
  - `out:` {ok, card}
- [x] `save_social_post` — Insert one social post into the review queue as status 'draft' (never publishes). · via `none`
  - `in:` {channel, content, slug?, title?, image_url?, force?} — no slug = standalone: synthetic slug
  - `out:` {post} | {skipped:true, reason}

### Hot Takes + signal feed (37)

- [x] `adopt_blog_draft` — Adopt a blog slug into a package (idempotent; wraps ensurePackageForSlug).
  - `in:` {slug:string}
  - `out:` {package}
- [x] `build_hottake_brief` — Build the brief (one LLM step over the approved take + patterns note; saves brief, status→brief). · via `llm`
  - `in:` {id:string}
  - `out:` {package}
- [x] `build_hottake_seed` — Assemble the article seed (deterministic prose from take + brief + the playbook's Article instruction; no LLM).
  - `in:` {id:string}
  - `out:` {id,title:string,body:string,voice:string}
- [x] `cancel_hottake_schedule` — Cancel a scheduled release (lookup-only, never creates; legs revert, calendar → cancelled).
  - `in:` {id?:string,slug?:string}
  - `out:` {package,posts,article,next_action}
- [x] `delete_heartbeat_source` — Delete a feed source (signals kept).
  - `in:` {id:string}
  - `out:` {ok:bool,id}
- [x] `delete_osint_target` — Delete a target and its mentions.
  - `in:` {id:string}
  - `out:` {ok:bool}
- [x] `draft_hottake_take` — Draft the take (one LLM step over POV library + playbook + prior takes; saves take fields, status→take). · via `llm`
  - `in:` {id:string}
  - `out:` {package}
- [x] `enrich_signals` ⚙️ — Re-score high-relevance signals from their full article text (bounded batch; fetch + one LLM re-judge each; caches text). · via `web+llm`
  - `in:` {limit?,min_relevance?}
  - `out:` {enriched:number,considered:number}
- [x] `extract_article_meta` — Extract article metadata from page text (one LLM step per the hottakes-link-extract note). · via `llm`
  - `in:` {url:string,text:string}
  - `out:` {title,source_name,summary,why_it_matters,published_at_iso}
- [x] `generate_digest` ⚙️ — Regenerate digest items from the enabled channels (wraps lib generateDigest; prune + per-channel pulls + dedupe). WORKFLOW-ONLY: registered for hourly-awareness-sweep, not surfaced to Nyo.
  - `in:` {since_ms?:number}
  - `out:` {generated:number,pruned:number,per_source:{}}
- [x] `ingest_signals` ⚙️ — Ingest all enabled feeds (insert unseen items as status 'new'; wraps lib ingestHeartbeat). · via `web`
  - `in:` {}
  - `out:` {inserted:number,per_source:[]}
- [x] `link_hottake_article` — Link a written blog draft to the package (blog_slug + headline + intro, status→review).
  - `in:` {id:string,slug:string,title?,excerpt?}
  - `out:` {package}
- [x] `list_heartbeat_sources` — List feed sources (rss + gnews).
  - `in:` {}
  - `out:` {sources:[src]}
- [x] `list_hot_topics` — List current hot topics (read-only topHotTopics).
  - `in:` {limit?,days?,q?}
  - `out:` {topics:[]}
- [x] `list_hottake_packages` — List publication packages.
  - `in:` {statuses?:[string],limit?:number}
  - `out:` {packages:[pkg]}
- [x] `list_osint_listeners` — List scraper engines with state + totals.
  - `in:` {}
  - `out:` {listeners:[]}
- [x] `list_osint_mentions` — List harvested mentions (filter by target/source).
  - `in:` {target_id?,source?,limit?}
  - `out:` {mentions:[]}
- [x] `list_osint_targets` — List monitored targets.
  - `in:` {}
  - `out:` {targets:[]}
- [x] `list_signals` — List recent scored signals.
  - `in:` {min_content?,days?,q?}
  - `out:` {signals:[sig]}
- [x] `list_topic_feed` — List the merged topic feed (hot topics + signals + digest lib, deduped, LIFO).
  - `in:` {limit?,offset?,q?,history?:bool}
  - `out:` {topics:[card],has_more:bool}
- [x] `pin_hottake_topic` — Pin a topic into a package (idempotent by origin_ref; no origin_ref = manual create).
  - `in:` {title,origin?,origin_ref?,summary?,why_it_matters?,source_name?,source_url?,published_at?}
  - `out:` {package}
- [x] `read_hottake_package` — Read one package (with its posts and next_action).
  - `in:` {id:string}
  - `out:` {found:bool,package,posts:[],next_action:string}
- [x] `read_industry_pulse` — Read the pulse (the industry-pulse note + top signals).
  - `in:` {}
  - `out:` {pulse:string,top_signals:[]}
- [x] `read_osint_target` — Read one target.
  - `in:` {id:string}
  - `out:` {found:bool,target?}
- [x] `read_signal` — Read one signal's full article (fetch + cache on first read). · via `web`
  - `in:` {signal_id:string}
  - `out:` {ok,title,source,url,content?}
- [x] `save_heartbeat_source` — Create or edit a feed source (gnews query builds the URL; enabled:false pauses).
  - `in:` {id?,kind?,name?,url?,query?,theme?,enabled?}
  - `out:` {source}
- [x] `save_hottake_package` — Patch a package (whitelisted fields; status:'dismissed' dismisses).
  - `in:` {id, ...patch}
  - `out:` {package}
- [x] `save_hottake_post` — Patch one social leg (body/notes/image_url/scheduled_at/status incl. not_planned).
  - `in:` {post_id, ...patch}
  - `out:` {post}
- [x] `save_osint_listener` — Patch a scraper engine (enabled/cadence/notes).
  - `in:` {source,enabled?,cadence?,notes?}
  - `out:` {listener}
- [x] `save_osint_target` — Create or update a target.
  - `in:` {id?,name,domain?,app_id?,notes?}
  - `out:` {target}
- [x] `save_signal` — Patch a signal (status: actioned/dismissed).
  - `in:` {signal_id:string,status:string}
  - `out:` {signal}
- [x] `scan_hottake_article` — Scan the article for claims + quality flags (one LLM step per quality-rules note; saves review; decision support, never auto-approval). · via `llm`
  - `in:` {id:string}
  - `out:` {package,open_claims:number,flags:number}
- [x] `schedule_hottake_release` — Schedule the release (wraps lib scheduleRelease: timing-note defaults, offset preservation, calendar mirror; never promotes legs to 'scheduled').
  - `in:` {id:string,website_at?,company_at?,personal_at?}
  - `out:` {package,posts,article,next_action}
- [x] `score_signals` ⚙️ — Score new signals (one batch LLM step per the heartbeat-priorities rubric; saves relevance/content_score/angle). · via `llm`
  - `in:` {limit?:number}
  - `out:` {scored:number}
- [x] `scrape_osint_targets` ⚙️ — Scrape targets with the enabled listeners ({id} = one target; omit id = stale targets, bounded by stale_after_ms/max_targets). · via `web`
  - `in:` {id?,sources?:[],stale_after_ms?,max_targets?}
  - `out:` {ran:[],skipped:[],per_source:[]}
- [x] `synthesize_hot_topics` — Synthesize hot topics from top signals (one strong-model LLM clustering step; upserts osint_topics). · via `llm`
  - `in:` {days?,min_content?}
  - `out:` {ok,count,topics:[]}
- [x] `synthesize_pulse` — Synthesize the industry-pulse knowledge doc from top signals (one LLM step; writes the note). · via `llm`
  - `in:` {}
  - `out:` {ok:bool,pulse:string}

### LinkedIn (11)

- [x] `get_linkedin_feed` — Read recent posts from the operator's home feed. · via `linkedin`
  - `in:` {count?}
  - `out:` {items:[{author, text, url, ...}]}
- [x] `list_linkedin_dms` — List DM conversation threads. · via `linkedin`
  - `in:` {limit?}
  - `out:` {conversations:[{conversation_urn, participant, last_message, ...}]}
- [x] `post_linkedin_text` — Publish one text post to the operator's feed (emergency fallback path only). · via `linkedin`
  - `in:` {body, visibility?}
  - `out:` {ok, posted, verified, post_url|null, outbox_id, note|error}
- [x] `probe_linkedin` — Probe the LinkedIn gateway session state. · via `linkedin`
  - `in:` {}
  - `out:` {url, reachable, ready, cookies_loaded, cookie_age_seconds, profile|null, error|null}
- [x] `react_linkedin_post` — React to one LinkedIn post by URL. · via `linkedin`
  - `in:` {post_url, reaction?}
  - `out:` {ok}
- [x] `read_linkedin_dm` — Read the messages of one DM thread. · via `linkedin`
  - `in:` {conversation_urn, limit?}
  - `out:` {messages:[{from, body, at, ...}]}
- [x] `read_linkedin_profile` — Read one LinkedIn profile by public_id. · via `linkedin`
  - `in:` {public_id}
  - `out:` {headline, current_company, summary, locations, experience[], education[], ...voyager blob}
- [x] `read_my_linkedin_profile` — Read the operator's own LinkedIn profile. · via `linkedin`
  - `in:` {}
  - `out:` {profile blob}
- [x] `search_linkedin_people` — Search LinkedIn people by keywords. · via `linkedin`
  - `in:` {keywords, limit?}
  - `out:` {results:[{name, headline, profile_urn_id, public_id, ...}]}
- [x] `send_linkedin_connection` — Send one connection request. · via `linkedin`
  - `in:` {profile_urn_id, note?, profile_urn?}
  - `out:` {ok, invitation_urn|null, outbox_id}
- [x] `send_linkedin_dm` — Send one direct message to a profile. · via `linkedin`
  - `in:` {profile_urn_id, body}
  - `out:` {ok, message_id|null, outbox_id}

---

## Referee decisions (merged twins + moved homes)

Five near-twin tools from different family designs were collapsed into one canonical tool:

- `draft_hottake_post` → use **`draft_social_post`**
- `send_hottake_post` → use **`push_social_post`**
- `draft_signal_post` → use **`draft_social_post (source_kind:"news")`**
- `publish_hottake_website` → use **`publish_blog_post`**
- `read_lead_thread` → use **`read_prospect_thread`**

Tools moved to the family that actually owns them: the WhatsApp gateway surface became its own shared family (12 tools used by Outreach, Prospecting and Nyo alike); social cards moved from the blog engine to Social; scheduled sends moved from Prospecting to Outreach; registry/health/notify moved to Core.

**One open question for you:** Hot Takes keeps its own `hot_take_posts` table separate from Social's `social_posts`. Unifying them (one table, optional package link) would delete a whole set of duplicate tools. Worth doing while we are refactoring?
