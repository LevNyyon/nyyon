// Outreach — Nyo tools (nyyon-lite shared pool), one verb on one noun each.
//
// Four things live here: the prospect CONVERSATIONS (WhatsApp threads + the
// suggested next message), the COHORTS (named campaigns and the automated
// ladder that walks each member forward), the REPLIES → pipeline promotion, and
// the SCHEDULED SENDS (a message queued for a future moment).
//
// Two rules the whole family exists to keep:
//   1. A prospect who has said anything back is out of the automation,
//      permanently — re-checked in the moment before each send, never merely
//      when the send was scheduled.
//   2. Nothing sends unattended. `require_approval` gates every cohort message,
//      the operator's explicit yes gates send_outreach / schedule_send, and the
//      `outreach.live` flag gates the cohort sender as a whole (until it is
//      true, the tick reports what it WOULD have sent).
//
// The tools marked ⚙️ in the architecture spec wrap an atomic library guarantee
// (claim-then-send, no-duplicate, fail-closed). They look batch-ish on purpose:
// splitting the loop would break the guarantee.

import {
  listCohorts, createCohort, updateCohort, deleteCohort, listCohortMembers,
  readSequence, saveSequence, generateStepCopy, enrollMany, goLive,
  approveMessages, saveMessageOverride, rescheduleMember, control, remove,
  listDueMembers, retireAnsweredMembers, renderMemberMessages, gateMemberApprovals, sendDueMessages,
} from '../lib/outreach-cohorts.js';
import { loadCohortCadence, saveCohortCadence } from '../lib/outreach-cadence.js';
import {
  listProspectThreads, readProspectThread, setConversationDead,
  loadDraftingRules, saveDraftingRules, pickNextBubble, composeReply,
} from '../lib/outreach-wa.js';
import { collectReplies, promoteRepliesToPipeline, loadPromotion, savePromotion } from '../lib/outreach-promote.js';
import { scheduleSend, cancelOrDismiss, listScheduled, scheduleConfig, runDueSends } from '../lib/gtm-schedule.js';
import { sendOutreach, readAngles } from '../lib/gtm-outreach.js';

export const tools = {
  // ── conversations ─────────────────────────────────────────────
  list_prospect_threads: {
    def: {
      name: 'list_prospect_threads',
      description: 'List the WhatsApp conversations that belong to PROSPECTS (people in the lead store we have a 1:1 chat with), newest first. Each row is classified: active (they have answered), unanswered (only our messages so far), fresh (fully enriched, never messaged), scheduled (a queued send waiting), dead (marked dead or nothing for dead_after_days). Read-only. Use to answer "who is in my outreach inbox" or "who is waiting on me".',
      input_schema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'filter by prospect name, company, title, or last message text' },
          status: { type: 'string', description: 'active (default) | working | unanswered | dead | fresh | all' },
          limit: { type: 'number', description: 'max conversations (default from the outreach-reply-drafting doc)' },
        },
        required: [],
      },
    },
    run: async (env, input) => listProspectThreads(env, {
      q: input?.q || '', limit: input?.limit || null, status: input?.status || 'active',
    }),
  },

  read_prospect_thread: {
    def: {
      name: 'read_prospect_thread',
      description: 'Open ONE prospect conversation: the full WhatsApp history (oldest first), whether they have ever answered, and the prospect context card (company, title, ICP fit and why, LinkedIn, open roles, org status). Pass chat_id, or lead_id to resolve the chat from the lead\'s phone. Read-only — opening a conversation never writes and never spends a model call.',
      input_schema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'WhatsApp DM id, e.g. 972545492444@c.us' },
          lead_id: { type: 'string', description: 'lead id — used to find the chat when chat_id is unknown' },
          limit: { type: 'number', description: 'max messages (default from the outreach-reply-drafting doc)' },
        },
        required: [],
      },
    },
    run: async (env, input) => readProspectThread(env, {
      chat_id: input?.chat_id || null, lead_id: input?.lead_id || null, limit: input?.limit || null,
    }),
  },

  mark_thread_dead: {
    def: {
      name: 'mark_thread_dead',
      description: 'Mark one prospect conversation dead so it drops out of the working list, or bring it back with dead:false. Keyed by person, not by chat id. Nothing is deleted either way, and un-marking restores the real state.',
      input_schema: {
        type: 'object',
        properties: {
          lead_id: { type: 'string' },
          dead: { type: 'boolean', description: 'true (default) to mark dead, false to revive' },
          reason: { type: 'string', description: 'optional short note, e.g. "not a fit"' },
        },
        required: ['lead_id'],
      },
    },
    run: async (env, input) => setConversationDead(env, {
      lead_id: input?.lead_id, dead: input?.dead !== false, reason: input?.reason || null,
    }),
  },

  read_lead_angles: {
    def: {
      name: 'read_lead_angles',
      description: "Read the outreach angles saved for one lead — the ranked plays and their draft message bubbles. Read-only; drafting new ones is draft_angles. Returns an empty list when nothing has been drafted for them yet.",
      input_schema: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'] },
    },
    run: async (env, input) => {
      const payload = await readAngles(env, input?.lead_id).catch(() => null);
      return { angles: Array.isArray(payload?.angles) ? payload.angles : [], angles_at: payload?.angles_at || null };
    },
  },

  read_drafting_rules: {
    def: {
      name: 'read_drafting_rules',
      description: 'Read how suggested replies are written and how much conversation the tab loads (the outreach-reply-drafting knowledge doc): the rules text plus thread_limit / message_limit / draft_context_messages / draft_context_chars.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => loadDraftingRules(env),
  },

  save_drafting_rules: {
    def: {
      name: 'save_drafting_rules',
      description: 'Change how suggested replies are written (the outreach-reply-drafting knowledge doc): the full rules text and/or the numeric limits. Pass only what changes. Use for "make the drafts shorter" or "load more history".',
      input_schema: {
        type: 'object',
        properties: {
          rules: { type: 'string', description: 'the full drafting rules text (replaces it)' },
          limits: {
            type: 'object',
            description: '{thread_limit, message_limit, draft_context_messages, draft_context_chars}',
            properties: {
              thread_limit: { type: 'number' },
              message_limit: { type: 'number' },
              draft_context_messages: { type: 'number' },
              draft_context_chars: { type: 'number' },
            },
          },
        },
        required: [],
      },
    },
    run: async (env, input) => saveDraftingRules(env, { rules: input?.rules, limits: input?.limits }),
  },

  pick_next_bubble: {
    def: {
      name: 'pick_next_bubble',
      description: "Pick the next message for a prospect who has NOT spoken yet: the next unsent bubble from their top saved angle, or the default first-touch template when they have no angle. Deterministic — no model call, so the words are exactly what was approved. Returns {needs_compose:true} instead when they HAVE replied, because then there is something to answer and compose_reply should write it. Reads the conversation from context (messages, answered, angles); never sends.",
      input_schema: {
        type: 'object',
        properties: {
          lead_id: { type: 'string' },
          prospect: { type: 'object', description: 'the prospect card from read_prospect_thread' },
          messages: { type: 'array', items: { type: 'object' }, description: 'the conversation, oldest first, from read_prospect_thread' },
          answered: { type: 'boolean', description: 'has the prospect ever replied (from read_prospect_thread)' },
          angles: { type: 'array', items: { type: 'object' }, description: 'saved angles from read_lead_angles' },
          force_llm: { type: 'boolean', description: 'hand straight to compose_reply even on a first touch' },
        },
        required: [],
      },
    },
    run: async (env, input) => pickNextBubble(env, {
      lead_id: input?.lead_id || null,
      prospect: input?.prospect || null,
      messages: input?.messages || [],
      answered: input?.answered ?? null,
      angles: input?.angles || [],
      force_llm: !!input?.force_llm,
    }),
  },

  compose_reply: {
    def: {
      name: 'compose_reply',
      description: "Write ONE reply to a prospect who has answered, grounded in the conversation, the saved angle and the drafting rules — a single model call. A no-op passthrough when the context already carries a draft (pick_next_bubble found an approved bubble), so an approved message is never overwritten. Returns a suggestion only; sending is a separate operator action via send_whatsapp.",
      input_schema: {
        type: 'object',
        properties: {
          prospect: { type: 'object', description: 'the prospect card from read_prospect_thread' },
          messages: { type: 'array', items: { type: 'object' }, description: 'the conversation, oldest first' },
          angles: { type: 'array', items: { type: 'object' }, description: 'saved angles from read_lead_angles' },
          rules: { type: 'string', description: 'the drafting rules text from read_drafting_rules' },
          limits: { type: 'object', description: 'the drafting limits from read_drafting_rules' },
          answered: { type: 'boolean' },
          draft: { type: 'string', description: 'an already-picked draft — present means passthrough' },
          source: { type: 'string', description: "where an already-picked draft came from ('angle' | 'template')" },
          needs_compose: { type: 'boolean', description: 'set by pick_next_bubble when a fresh reply is wanted' },
          force_llm: { type: 'boolean', description: 'compose even when a draft is already present' },
        },
        required: [],
      },
    },
    run: async (env, input) => composeReply(env, {
      prospect: input?.prospect || null,
      messages: input?.messages || [],
      angles: input?.angles || [],
      rules: input?.rules ?? null,
      limits: input?.limits ?? null,
      answered: input?.answered ?? null,
      draft: input?.draft ?? null,
      source: input?.source ?? null,
      needs_compose: !!input?.needs_compose,
      force_llm: !!input?.force_llm,
    }),
  },

  // ── cohorts (the named campaigns) ─────────────────────────────
  list_cohorts: {
    def: {
      name: 'list_cohorts',
      description: 'List the named outreach cohorts (campaigns) with how many prospects each holds — total, active and answered — plus each one\'s status and sending window. Read-only.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => listCohorts(env),
  },

  create_cohort: {
    def: {
      name: 'create_cohort',
      description: 'Create a named outreach cohort. Idempotent by name — creating one that already exists hands back the existing cohort rather than a duplicate.',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' }, note: { type: 'string', description: 'optional description' } },
        required: ['name'],
      },
    },
    run: async (env, input) => createCohort(env, { name: input?.name, note: input?.note || null }),
  },

  update_cohort: {
    def: {
      name: 'update_cohort',
      description: "Change a cohort's settings: name, status (active | paused | finished | canceled), timezone, start_hour/end_hour, send_days (0=Sunday…6=Saturday), send_windows and languages. STATUS GATES THE SENDER — anything other than active stops every scheduled message inside that cohort at once, without moving anyone or losing their place in the ladder. Window fields are the cohort's own; leave them unset to inherit the account default from the cadence doc.",
      input_schema: {
        type: 'object',
        properties: {
          cohort_id: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string', description: 'active | paused | finished | canceled' },
          timezone: { type: 'string', description: 'IANA zone, e.g. Asia/Jerusalem. Empty string clears it.' },
          start_hour: { type: 'number' },
          end_hour: { type: 'number' },
          send_days: { type: 'array', items: { type: 'number' }, description: '0=Sunday … 6=Saturday. Superseded by send_windows when that is set.' },
          send_windows: {
            type: 'object',
            description: 'Eligible sending times per weekday, to the minute, in the cohort timezone: {"1":{"start":"09:00","end":"17:30"}} where 0=Sunday. A weekday that is ABSENT sends nothing. Overrides start_hour/end_hour and send_days entirely. Pass {} to clear it and inherit the account default window.',
          },
          languages: { type: 'array', items: { type: 'string' } },
        },
        required: ['cohort_id'],
      },
    },
    run: async (env, input) => updateCohort(env, input || {}),
  },

  delete_cohort: {
    def: {
      name: 'delete_cohort',
      description: 'Delete an empty cohort. Refuses while any prospect is still enrolled in it, and refuses the default cohort.',
      input_schema: { type: 'object', properties: { cohort_id: { type: 'string' } }, required: ['cohort_id'] },
    },
    run: async (env, input) => deleteCohort(env, { cohort_id: input?.cohort_id }),
  },

  read_sequence: {
    def: {
      name: 'read_sequence',
      description: "Read a cohort's message sequence — the copy the whole group receives, written once and personalised per recipient — plus a validation report (steps, languages, variables used, unknown variables, unwired channels). Read-only.",
      input_schema: { type: 'object', properties: { cohort_id: { type: 'string' } }, required: ['cohort_id'] },
    },
    run: async (env, input) => readSequence(env, { cohort_id: input?.cohort_id }),
  },

  save_sequence: {
    def: {
      name: 'save_sequence',
      description: "Write a cohort's message sequence. Shape: {default_language, steps:[{delay_hours, channel, bodies:{en:\"…\", he:\"…\"}}]} — delay_hours on step 0 counts from go-live, later steps from the previous send. Bodies may use {first_name} {name} {company} {position} {country}; any other {token} is rejected. `scope` decides what happens to people already in the cohort: new_only (default — anyone hand-edited keeps their own message) or everyone (the cohort copy replaces the hand-written ones too). APPROVALS ARE WITHDRAWN EITHER WAY for anyone whose next message this changes, because approval means the operator read that exact text.",
      input_schema: {
        type: 'object',
        properties: {
          cohort_id: { type: 'string' },
          sequence: { type: 'object', description: '{default_language, steps:[{delay_hours, channel, bodies:{lang:text}}]}' },
          scope: { type: 'string', description: 'new_only (default) | everyone' },
        },
        required: ['cohort_id', 'sequence'],
      },
    },
    run: async (env, input) => saveSequence(env, {
      cohort_id: input?.cohort_id, sequence: input?.sequence, scope: input?.scope || 'new_only',
    }),
  },

  draft_step_copy: {
    def: {
      name: 'draft_step_copy',
      description: "Draft the copy for ONE step of a cohort's sequence, using the cohort name and a sample of who is actually in it as the brief. One model call. Returns the text for the operator to read and edit — it never saves and never sends, so \"every automated message was approved\" stays true even when a model helped write it. step_index 0 is the cold opener.",
      input_schema: {
        type: 'object',
        properties: {
          cohort_id: { type: 'string' },
          step_index: { type: 'number', description: '0 = first touch' },
          language: { type: 'string', description: 'e.g. en, he' },
          instruction: { type: 'string', description: 'optional steer, e.g. "shorter, lead with the hiring signal"' },
        },
        required: ['cohort_id'],
      },
    },
    run: async (env, input) => generateStepCopy(env, {
      cohort_id: input?.cohort_id, step_index: Number(input?.step_index) || 0,
      language: input?.language || 'en', instruction: input?.instruction || '',
    }),
  },

  read_cadence: {
    def: {
      name: 'read_cadence',
      description: 'Read the cohort cadence rules (the outreach-cohort-cadence knowledge doc): step_delays_hours, max_sends_per_day, min_gap_minutes, quiet hours, weekdays_only, timezone, dead_after_days, require_approval and max_message_chars.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => loadCohortCadence(env),
  },

  save_cadence: {
    def: {
      name: 'save_cadence',
      description: 'Change the cohort cadence rules (the outreach-cohort-cadence knowledge doc). Pass only what changes. require_approval is the master gate: while true the sender refuses any message the operator has not individually approved — turning it off makes every scheduled message send unattended, so confirm that explicitly before doing it.',
      input_schema: {
        type: 'object',
        properties: {
          step_delays_hours: { type: 'array', items: { type: 'number' } },
          max_sends_per_day: { type: 'number' },
          min_gap_minutes: { type: 'number' },
          quiet_start_hour: { type: 'number' },
          quiet_end_hour: { type: 'number' },
          weekdays_only: { type: 'boolean' },
          timezone: { type: 'string' },
          dead_after_days: { type: 'number' },
          require_approval: { type: 'boolean', description: 'the single switch that can hold every send' },
          max_message_chars: { type: 'number' },
        },
        required: [],
      },
    },
    run: async (env, input) => saveCohortCadence(env, input || {}),
  },

  // ── members (one person's place in the ladder) ────────────────
  list_cohort_members: {
    def: {
      name: 'list_cohort_members',
      description: 'List enrolled prospects with everything the sheet shows: which cohort, what we last said, the NEXT message rendered for that person (variables filled, in their language), when it goes, whether the operator approved it, and where their real conversation stands (untouched | touched | active | dead). Filter with status (staged | active | answered | paused | done | stopped | all) and/or cohort_id. Read-only; also returns the cohorts and whether live sending is on.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'staged | active | answered | paused | done | stopped | all' },
          cohort_id: { type: 'string', description: 'limit to one cohort; omit or "all" for every cohort' },
        },
        required: [],
      },
    },
    run: async (env, input) => listCohortMembers(env, {
      status: input?.status || null, cohort_id: input?.cohort_id || null,
    }),
  },

  enroll_members: {
    def: {
      name: 'enroll_members',
      description: 'Stage prospects into a cohort. They are STAGED, not scheduled — filing someone into a cohort must never be the thing that causes a message; launch_members is the only step that arms one. Returns three lists: added, conflicts (already in ANOTHER cohort — nobody may be in two, so these need an explicit override) and skipped (no phone, already replied, already in this cohort). Pass override:true ONLY after a human approved moving those specific people; an override MOVES them, it never duplicates.',
      input_schema: {
        type: 'object',
        properties: {
          lead_ids: { type: 'array', items: { type: 'string' } },
          cohort_id: { type: 'string', description: 'target cohort; defaults to the general one' },
          override: { type: 'boolean', description: 'move prospects already enrolled elsewhere — requires operator approval' },
        },
        required: ['lead_ids'],
      },
    },
    run: async (env, input) => enrollMany(env, {
      lead_ids: input?.lead_ids || [], cohort_id: input?.cohort_id || null, override: !!input?.override,
    }),
  },

  launch_members: {
    def: {
      name: 'launch_members',
      description: "Schedule specific STAGED prospects to start their cohort's sequence. This is the ONLY thing that turns a staged enrolment into scheduled messages. Refuses anyone whose messages would not render cleanly (a missing {company}, a cohort with no sequence yet) and reports them in `blocked` rather than arming something with a gap in it. Actual delivery still needs the message approved and the outreach.live flag on.",
      input_schema: {
        type: 'object',
        properties: {
          lead_ids: { type: 'array', items: { type: 'string' } },
          start_at: { type: 'number', description: 'ms epoch to start from; defaults to now (still held to the sending window)' },
        },
        required: ['lead_ids'],
      },
    },
    run: async (env, input) => goLive(env, { lead_ids: input?.lead_ids || [], start_at: input?.start_at || null }),
  },

  approve_message: {
    def: {
      name: 'approve_message',
      description: 'Approve (or withdraw approval of) the NEXT message for one or more cohort members. Approval is per message, not per person: it applies to the exact step each prospect is on and lapses by itself the moment that message is sent, so the following one needs approving again. Approving neither schedules nor sends. Refuses anyone who has replied, whose copy cannot be filled in, or whose edited message has a hole in it — a 200 does not mean everyone was approved, read the refused list.',
      input_schema: {
        type: 'object',
        properties: {
          lead_ids: { type: 'array', items: { type: 'string' } },
          approve: { type: 'boolean', description: 'false to withdraw a previous approval. Defaults to true.' },
        },
        required: ['lead_ids'],
      },
    },
    run: async (env, input) => approveMessages(env, {
      lead_ids: input?.lead_ids || [], approve: input?.approve !== false,
    }),
  },

  override_message: {
    def: {
      name: 'override_message',
      description: "Rewrite the next message for ONE prospect, for that prospect only — the cohort's own copy is untouched and everyone else still gets what was authored for the group. The edit is bound to the step they are on, so it can never become the text of a later message. Variables still work and are refused at save time if this prospect has no value for them. Saving an edit WITHDRAWS any approval, because approval means the operator read the text and the text just changed. clear:true drops the edit and restores the cohort copy.",
      input_schema: {
        type: 'object',
        properties: {
          lead_id: { type: 'string' },
          text: { type: 'string', description: 'the replacement message' },
          clear: { type: 'boolean', description: 'true to remove the edit and restore the cohort copy' },
        },
        required: ['lead_id'],
      },
    },
    run: async (env, input) => saveMessageOverride(env, {
      lead_id: input?.lead_id, text: input?.text || '', clear: !!input?.clear,
    }),
  },

  reschedule_member: {
    def: {
      name: 'reschedule_member',
      description: "Move WHEN one prospect's next message goes out. Stores exactly the moment given — it is NOT snapped into the cohort's window, because the sender only runs inside that window anyway, so an out-of-window time simply means the first chance after it; the reply says `outside_window` when that is the case. Giving a time to a STAGED prospect is a launch and carries the same guard (their whole sequence must render cleanly first). Does not touch approval: moving when a message goes does not change what it says. Refused for anyone who has replied, or who is stopped/finished.",
      input_schema: {
        type: 'object',
        properties: { lead_id: { type: 'string' }, send_at: { type: 'number', description: 'ms epoch' } },
        required: ['lead_id', 'send_at'],
      },
    },
    run: async (env, input) => rescheduleMember(env, { lead_id: input?.lead_id, send_at: input?.send_at }),
  },

  pause_member: {
    def: {
      name: 'pause_member',
      description: "Pause one prospect's automated ladder, or resume it with paused:false. Pausing keeps their place and their approval; resuming is refused for anyone who has replied, because a prospect who answered is out of the automation permanently.",
      input_schema: {
        type: 'object',
        properties: { lead_id: { type: 'string' }, paused: { type: 'boolean', description: 'true to pause, false to resume' } },
        required: ['lead_id', 'paused'],
      },
    },
    run: async (env, input) => control(env, { lead_id: input?.lead_id, action: input?.paused === false ? 'resume' : 'pause' }),
  },

  stop_member: {
    def: {
      name: 'stop_member',
      description: "Stop one prospect's ladder for good. Terminal but visible — the enrolment row stays, so the operator can see it was stopped rather than wondering where they went. Use remove_member to take them off the cohort entirely.",
      input_schema: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'] },
    },
    run: async (env, input) => control(env, { lead_id: input?.lead_id, action: 'stop' }),
  },

  unschedule_member: {
    def: {
      name: 'unschedule_member',
      description: "Return one prospect to a draft: they keep their place in the ladder and their approval, they simply have no send time any more. The sender only ever picks up rows that have one, so this takes them out of the run without stopping them. Give them a time again with reschedule_member or launch_members.",
      input_schema: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'] },
    },
    run: async (env, input) => control(env, { lead_id: input?.lead_id, action: 'unschedule' }),
  },

  remove_member: {
    def: {
      name: 'remove_member',
      description: 'Take one prospect off the cohort entirely (deletes the enrolment row). Their conversation and message history are untouched.',
      input_schema: {
        type: 'object',
        properties: { lead_id: { type: 'string' }, reason: { type: 'string' } },
        required: ['lead_id'],
      },
    },
    run: async (env, input) => remove(env, { lead_id: input?.lead_id, reason: input?.reason || 'manual' }),
  },

  // ── the cohort tick, as its five decisions ────────────────────
  list_due_members: {
    def: {
      name: 'list_due_members',
      description: "List the cohort members whose next message is due right now, inside the sending window, with how much of today's send budget is left. Returns ran:false with a reason when the window is shut or the daily cap is spent. Read-only. Step 1 of the outreach-cohort-tick workflow; also useful alone to answer \"what is going out today\".",
      input_schema: {
        type: 'object',
        properties: {
          force: { type: 'boolean', description: 'ignore the quiet-hours / weekday window' },
          dry_run: { type: 'boolean', description: 'true = never send, just report. Defaults to the outreach.live flag.' },
          limit: { type: 'number', description: 'max members to consider this pass (capped at 50)' },
        },
        required: [],
      },
    },
    run: async (env, input) => listDueMembers(env, {
      force: !!input?.force,
      dry_run: input?.dry_run === undefined ? null : !!input.dry_run,
      limit: input?.limit || null,
    }),
  },

  retire_answered_members: {
    def: {
      name: 'retire_answered_members',
      description: "Re-read every due member's live conversation and retire anyone who has said something back — permanently, because once a human has spoken the conversation belongs to a human. Runs on ALL due rows, approved or not: skipping the unapproved ones would leave a prospect who replied sitting active forever. Returns the due list with those people removed. A conversation that cannot be read is dropped from this pass rather than sent to (fail-closed). Step 2 of the outreach-cohort-tick workflow.",
      input_schema: {
        type: 'object',
        properties: { due: { type: 'array', items: { type: 'object' }, description: 'due members from list_due_members' } },
        required: [],
      },
    },
    run: async (env, input) => retireAnsweredMembers(env, { due: input?.due || [] }),
  },

  render_member_messages: {
    def: {
      name: 'render_member_messages',
      description: "Render each due member's next message — the cohort's copy for that step, or the operator's per-person edit — filled in with that prospect's own values. Fail-closed: a message that cannot be filled cleanly (a missing {company}, an unwired channel, a spent ladder) STOPS that member and lands in `blocked` rather than going out with a hole in it. Returns the sendable list. Step 3 of the outreach-cohort-tick workflow.",
      input_schema: {
        type: 'object',
        properties: { due: { type: 'array', items: { type: 'object' }, description: 'due members, after retire_answered_members' } },
        required: [],
      },
    },
    run: async (env, input) => renderMemberMessages(env, { due: input?.due || [] }),
  },

  gate_member_approvals: {
    def: {
      name: 'gate_member_approvals',
      description: "Hold back any sendable message the operator has not approved for its exact step, while the cadence doc's require_approval is on. Held rows keep their send time on purpose, so an unapproved message stays a visible backlog at the top of its cohort instead of quietly dropping out of the run. Returns the sendable list narrowed to approved messages plus what is awaiting. Step 4 of the outreach-cohort-tick workflow.",
      input_schema: {
        type: 'object',
        properties: { sendable: { type: 'array', items: { type: 'object' }, description: 'rendered messages from render_member_messages' } },
        required: [],
      },
    },
    run: async (env, input) => gateMemberApprovals(env, { sendable: input?.sendable || [] }),
  },

  send_due_messages: {
    def: {
      name: 'send_due_messages',
      description: "SEND the approved due cohort messages, within the daily budget and with human spacing between them. For each one the library re-reads the conversation in the moment before it leaves (a reply that landed since is retired, not messaged), advances the step in the same write as the send, and fail-closes on any error — the prospect is stopped, never automatically retried, because a silent retry is how duplicates happen. dry_run reports exactly what would have gone and writes nothing. THIS MESSAGES REAL PEOPLE. Step 5 of the outreach-cohort-tick workflow.",
      input_schema: {
        type: 'object',
        properties: {
          sendable: { type: 'array', items: { type: 'object' }, description: 'approved messages from gate_member_approvals' },
          budget: { type: 'number', description: "how many sends are left in today's cap (from list_due_members)" },
          dry_run: { type: 'boolean', description: 'true = report would-send and write nothing' },
        },
        required: [],
      },
    },
    run: async (env, input) => sendDueMessages(env, {
      sendable: input?.sendable || [],
      budget: Number(input?.budget) || 0,
      // Defaults to a dry run: the safe direction for a missing flag here is
      // "nothing sent", never "sent unread".
      dry_run: input?.dry_run === undefined ? true : !!input.dry_run,
    }),
  },

  // ── replies → pipeline ────────────────────────────────────────
  collect_replies: {
    def: {
      name: 'collect_replies',
      description: 'Collect everyone who REPLIED to our outreach — LinkedIn (prospects marked replied) and WhatsApp (an inbound message after our first send) — normalized to {source, name, company, title, phone, linkedin, lead_id, replied_at}. Read-only. Step 1 of the outreach-replies-to-pipeline workflow; also useful alone to answer "who has answered".',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => collectReplies(env),
  },

  promote_replies: {
    def: {
      name: 'promote_replies',
      description: "Put replied people on the sales pipeline: create a new prospect client at the replied stage, or advance an existing one FORWARD only — a deal already further along is left where it is. Matches to existing records by linked lead → contact phone/LinkedIn → client name, so re-running never duplicates anyone. Takes { replies } as produced by collect_replies. Rules come from the outreach-promotion knowledge doc. Step 2 of the outreach-replies-to-pipeline workflow.",
      input_schema: {
        type: 'object',
        properties: {
          replies: {
            type: 'array',
            items: { type: 'object' },
            description: "Reply objects from collect_replies. Omit inside the workflow — the runner threads step 1's output in.",
          },
        },
        required: [],
      },
    },
    run: async (env, input) => promoteRepliesToPipeline(env, { replies: input?.replies }),
  },

  read_promotion_rules: {
    def: {
      name: 'read_promotion_rules',
      description: 'Read how replies become deals (the outreach-promotion knowledge doc): replied_stage (where a reply lands someone), advance_only (never move a further-along deal back), stage_rank (the board order used to decide "forward") and the tag stamped on promoted records.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => loadPromotion(env),
  },

  save_promotion_rules: {
    def: {
      name: 'save_promotion_rules',
      description: 'Change how replies become deals (the outreach-promotion knowledge doc). Pass only the fields that change. Use for "land replies at talking instead of lead".',
      input_schema: {
        type: 'object',
        properties: {
          replied_stage: { type: 'string' },
          advance_only: { type: 'boolean' },
          stage_rank: { type: 'array', items: { type: 'string' } },
          tag: { type: 'string' },
        },
        required: [],
      },
    },
    run: async (env, input) => savePromotion(env, input || {}),
  },

  // ── scheduled sends ───────────────────────────────────────────
  schedule_send: {
    def: {
      name: 'schedule_send',
      description: "SCHEDULE outreach bubbles to one lead's WhatsApp for a future moment (ms epoch). Fires on the first cron tick at or after send_at — up to ~40 minutes late, NEVER early, NEVER twice. Duplicates are structurally blocked: content identical to anything ever sent to this lead is refused, only one live schedule per lead+content, the runner claims atomically and fails closed. THIS WILL MESSAGE A REAL PERSON at the scheduled time — show the operator the exact bubbles and time and get an explicit yes first.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'lead id' },
          bubbles: { type: 'array', items: { type: 'string' }, description: 'max 4 — the playbook caps a touch at 4' },
          send_at: { type: 'number', description: 'ms epoch, future' },
        },
        required: ['id', 'bubbles', 'send_at'],
      },
    },
    run: async (env, input) => {
      const r = await scheduleSend(env, { lead_id: input?.id, bubbles: input?.bubbles, send_at: input?.send_at });
      // The lib names the row `id`; the shared context already carries a lead
      // `id`, so hand it back under a name that cannot be mistaken for one.
      return r?.error ? r : { ...r, schedule_id: r.id };
    },
  },

  cancel_scheduled_send: {
    def: {
      name: 'cancel_scheduled_send',
      description: 'Cancel a scheduled send before it fires, or dismiss a terminal failed/partial one (the reply says which of the two happened). A claimed, in-flight send cannot be un-fired — that is the fail-closed guarantee, and it is an operator decision to review rather than a retry queue.',
      input_schema: {
        type: 'object',
        properties: { schedule_id: { type: 'string', description: 'the ss_ schedule id' } },
        required: ['schedule_id'],
      },
    },
    run: async (env, input) => cancelOrDismiss(env, input?.schedule_id),
  },

  list_scheduled_sends: {
    def: {
      name: 'list_scheduled_sends',
      description: 'List scheduled sends (live + failed by default) with the schedule defaults from the gtm-schedule knowledge doc — the send hour, days-ahead, jitter and timezone the picker offers. Filter by lead; include_done:true adds sent and cancelled history. Read-only.',
      input_schema: {
        type: 'object',
        properties: {
          lead_id: { type: 'string' },
          include_done: { type: 'boolean', description: 'add sent/cancelled history' },
        },
        required: [],
      },
    },
    run: async (env, input) => ({
      schedules: await listScheduled(env, { lead_id: input?.lead_id || null, include_done: !!input?.include_done }),
      defaults: await scheduleConfig(env),
    }),
  },

  run_due_sends: {
    def: {
      name: 'run_due_sends',
      description: 'Run the scheduled-send tick now (the same pass the cron runs): claim every due schedule atomically and deliver it. Safe to call repeatedly — a claim is one-shot and a second run can never duplicate a send. Returns how many were claimed, sent, partial and failed.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    run: async (env) => runDueSends(env),
  },

  send_outreach: {
    def: {
      name: 'send_outreach',
      description: "SEND outreach bubbles to one lead's WhatsApp right now, humanly paced (each bubble its own message, 4-9s jittered gaps, stops on the first failure, max 4 bubbles, every one logged). THIS MESSAGES A REAL PERSON — always show the operator the exact bubbles and get an explicit yes before calling it. A paced send can outlive the tool timeout: if this times out do NOT retry, the send is still running. A repeat to the same lead within 10 minutes is refused unless force:true, and only after the operator confirms a deliberate re-send.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'lead id' },
          bubbles: { type: 'array', items: { type: 'string' }, description: 'max 4' },
          force: { type: 'boolean', description: 'override the 10-minute repeat refusal — operator-confirmed only' },
        },
        required: ['id', 'bubbles'],
      },
    },
    run: async (env, input) => sendOutreach(env, {
      lead_id: input?.id, bubbles: input?.bubbles || [], force: !!input?.force,
    }),
  },
};
