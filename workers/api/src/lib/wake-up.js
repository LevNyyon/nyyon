// Nyo wake-up — proactive survey + catchup. Business rules extracted from
// the /api/system/wake-up route (index.js), behavior-identical. Surveys
// what's happened, what's pending, what's failed, and (optionally) fires any
// AEO publish that should already have happened today. Composes a markdown
// "morning briefing" and queues it as a Nyo pending message so the floating
// button badges.
//
// Idempotent: if there's been no material change since the last wake-up
// (no new failures, no missed publishes, no new pending work), skips
// queueing so the operator doesn't get spammed every tab refocus.
//
// Thresholds (cadence hours, heartbeat, outbox retry window + limit) are
// EDITABLE: they live in the `wake-up-policy` knowledge doc as JSON. The
// defaults below are seeded into the doc on first run; a missing or broken
// doc falls back to the defaults — a bad edit must never kill the wake-up.

import {
  readKnowledge, writeKnowledge,
  queueNyoMessage, logEvent, logWorkflowRun,
} from './db.js';
import { EVENT_KINDS } from './event-kinds.js';
import { syncFromGateway } from './whatsapp.js';
import { retryOutboxRow } from './outbox.js';

const POLICY_SLUG = 'wake-up-policy';

// ─── week math (inlined from the departed lib/brain.js) ─────────────────────
// Returns ms-epoch of the most recent Sunday at 00:00 local time. Workers run
// in UTC; we don't have the operator's tz, so we use UTC Sunday — close enough
// for a weekly cadence, and consistent with the plugin's own brain engine.
function weekOfSunday(ts = Date.now()) {
  const d = new Date(ts);
  const day = d.getUTCDay();             // 0 = Sunday
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);    // back up to Sunday
  return d.getTime();
}

// Seeded defaults — mirrored into the knowledge doc so the operator can tune
// them without a deploy.
const POLICY_DEFAULTS = Object.freeze({
  // A publish is "overdue" once this many hours have passed since the last one.
  cadence_hours: 18,
  // Re-brief a standing (unchanged) problem at most once per this many hours.
  heartbeat_hours: 20,
  // Look-back window (hours) for outbox failures — both the briefing stat and
  // the auto-retry candidate query.
  outbox_window_hours: 72,
  // Max outbox auto-retries per wake-up.
  outbox_retry_limit: 5,
  // HARD CAP between queued chat briefings, regardless of reason. The operator
  // asked for the "👋 Morning" message once a day, not on every state change —
  // 20h ≈ daily with drift room. Server-side actions (autofire, retries) still
  // run on capped ticks; only the chat message is suppressed (visible in
  // Activity / Workflows instead).
  briefing_gap_hours: 20,
});

// Coerce a policy field to a finite number, else the default. A garbage value
// in the doc (e.g. "banana") must degrade to the default, not break SQL.
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Read the policy doc; seed it with the defaults if it doesn't exist yet.
// Any read/parse/seed failure falls back to the defaults.
async function loadWakeUpPolicy(env) {
  try {
    const doc = await readKnowledge(env, POLICY_SLUG);
    if (!doc) {
      await writeKnowledge(env, {
        slug: POLICY_SLUG,
        title: 'Wake-up policy — cadence + retry thresholds',
        body: JSON.stringify(POLICY_DEFAULTS, null, 2),
      });
      return { ...POLICY_DEFAULTS };
    }
    const parsed = JSON.parse(doc.body);
    const src = (parsed && typeof parsed === 'object') ? parsed : {};
    return {
      cadence_hours:       num(src.cadence_hours,       POLICY_DEFAULTS.cadence_hours),
      heartbeat_hours:     num(src.heartbeat_hours,     POLICY_DEFAULTS.heartbeat_hours),
      outbox_window_hours: num(src.outbox_window_hours, POLICY_DEFAULTS.outbox_window_hours),
      outbox_retry_limit:  num(src.outbox_retry_limit,  POLICY_DEFAULTS.outbox_retry_limit),
      briefing_gap_hours:  num(src.briefing_gap_hours,  POLICY_DEFAULTS.briefing_gap_hours),
    };
  } catch (e) {
    console.error('wake-up-policy doc unreadable — using defaults:', e?.message || e);
    return { ...POLICY_DEFAULTS };
  }
}

// Run the full wake-up. opts: { autofire?: boolean } — if true (default),
// missed AEO publish gets actually fired. If false, just reports what would
// be done. Returns { status, body } — the route serializes body as JSON with
// that HTTP status (same shapes the inline route returned).
export async function runWakeUp(env, opts = {}) {
  const autofire = opts.autofire !== false; // default true
  const now = Date.now();

  const policy = await loadWakeUpPolicy(env);

  // Pull the latest WhatsApp from the gateway (source of truth) into the D1
  // cache before surveying — keeps the digest + find_wa_chat current. Best-effort.
  await syncFromGateway(env).catch(() => {});

  // Each query wrapped so we don't fail the whole wake-up if one table is
  // missing (e.g. outbound_log not yet migrated in some env).
  async function safeFirst(sql, ...args) {
    try { return await env.DB.prepare(sql).bind(...args).first(); }
    catch (e) { return null; }
  }
  async function safeAll(sql, ...args) {
    try { return (await env.DB.prepare(sql).bind(...args).all()).results || []; }
    catch (e) { return []; }
  }

  // 0. Sunday Brain — if it's Sunday and we haven't offered this week's
  //    editorial brain yet, queue the proactive "ready?" message. This is
  //    what makes Nyo ask the operator when they open the app on Sunday.
  //    Idempotent: gated on a brain session existing for the week.
  //    The brain engine itself lives in the editorial plugin now
  //    (plugin_editorial_brain_sessions is its table — host reads it, per the
  //    host-reads grant); weekOfSunday is inlined below since lib/brain.js
  //    went with the pack.
  try {
    const isSunday = new Date(now).getUTCDay() === 0;
    if (isSunday) {
      const week = weekOfSunday(now);
      const session = await safeFirst(`SELECT id, status FROM plugin_editorial_brain_sessions WHERE week_of = ? LIMIT 1`, week);
      const offered = await safeFirst(
        `SELECT created_at FROM events WHERE kind = ? AND created_at >= ? LIMIT 1`, EVENT_KINDS.BRAIN_OFFER_SENT, week,
      );
      // Offer only if no session exists yet AND we haven't offered this week.
      if (!session && !offered) {
        // Never offer a flow we can't run: deriving the slate needs the
        // Anthropic tiers. While the credit breaker is open, stay quiet and
        // do NOT stamp the weekly claim — the offer fires once health recovers.
        const { getLlmHealth } = await import('./llm.js');
        const llm = await getLlmHealth(env);
        if (llm.status !== 'ok') {
          console.log('brain offer suppressed — llm health:', llm.status, llm.reason || '');
          throw Object.assign(new Error('llm down — brain offer suppressed'), { quiet: true });
        }
        // Claim the week FIRST (the dedup marker IS the guard): if this write
        // fails to persist, abort without sending — otherwise every wake-up
        // that day re-reads `offered=false` and re-nags. Claiming first means a
        // rare failure costs at most one skipped nudge (operator can start the
        // brain by hand), never an unbounded repeat.
        try {
          await logEvent(env, { kind: EVENT_KINDS.BRAIN_OFFER_SENT, actor: 'system', payload: { week_of: week } });
        } catch (e) {
          console.error('brain_offer_sent marker failed — skipping this week\'s offer to avoid repeat-nagging:', e?.message || e);
          throw e; // handled by the outer catch; no message goes out
        }
        await queueNyoMessage(env, {
          kind: 'brain_offer',
          content:
            `🧠 **It's Sunday — ready for this week's editorial brain?**\n\n` +
            `I'll ask you ~18 quick questions — what you shipped, your hot takes, anything live in AI/marketing this week, a client win, a prediction — and turn your answers into the whole week's article slate.\n\n` +
            `Say **"let's go"** when you're ready and I'll start. Takes about 10 minutes.`,
          payload: { week_of: week },
        });
      }
    }
  } catch (e) { console.error('brain-offer wake-up step skipped:', e?.message || e); }

  // 1. Stats: pending AEO questions, last successful publish, recent failures.
  const pendingAeo  = await safeFirst(`SELECT COUNT(*) AS n FROM plugin_editorial_aeo_questions WHERE status = 'pending'`);
  const failedAeo   = await safeFirst(`SELECT COUNT(*) AS n FROM plugin_editorial_aeo_questions WHERE status = 'failed'`);
  const lastPublish = await safeFirst(`SELECT slug, title, published_at FROM plugin_editorial_blog_posts WHERE published = 1 ORDER BY published_at DESC LIMIT 1`);

  // 2. Recent outbox failures (any channel) in the policy window.
  const recentFails = await safeAll(
    `SELECT channel, COUNT(*) AS n FROM outbound_log WHERE status = 'failed' AND created_at > ? GROUP BY channel`,
    now - policy.outbox_window_hours * 3600 * 1000,
  );

  // 3. Was the last wake-up notification before any material event since?
  const lastWakeUp   = await safeFirst(`SELECT created_at, payload FROM events WHERE kind = 'nyo_wake_up_sent' ORDER BY created_at DESC LIMIT 1`);
  const lastWakeUpAt = lastWakeUp?.created_at || 0;
  // Signature of the briefing we last sent — lets us tell "same news" from
  // "new news" and skip re-posting an identical briefing on every refocus.
  let lastSig = null;
  try { lastSig = lastWakeUp?.payload ? (JSON.parse(lastWakeUp.payload)?.state_sig ?? null) : null; } catch { /* legacy event without a sig */ }

  const hoursSincePublish = lastPublish?.published_at ? Math.round((now - lastPublish.published_at) / 3600000) : null;
  // Don't consider "no publishes ever" as overdue — that's a fresh install,
  // not a missed run.
  const overdue = hoursSincePublish != null && hoursSincePublish >= policy.cadence_hours;

  // 5. Take action. `actions` accumulates everything Nyo does this wake-up —
  // they get rendered in a dedicated section of the briefing so the operator
  // sees "what I did" not just "what's pending". Skipped entirely when
  // autofire is false (preview mode).
  const actions = [];   // [{ kind, ok, label, detail? }]
  let fired = null;
  let cadenceBlocked = false;   // overdue, but nothing is publishable yet (every pending question still needs its interview)

  // Once-per-day cap on the autonomous publish. The wake-up fires on every
  // app open + tab refocus, so without this guard the catchup could publish
  // several articles a day whenever multiple are queued. We allow at most ONE
  // autofire publish per UTC day: skip if a publish already landed today OR
  // we already attempted an autofire today.
  const dayStartUTC = (() => { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime(); })();
  const publishedToday = (lastPublish?.published_at || 0) >= dayStartUTC;
  const autofiredToday = !!(await safeFirst(
    `SELECT 1 AS x FROM events WHERE kind = ? AND created_at >= ? LIMIT 1`, EVENT_KINDS.AEO_AUTOFIRE, dayStartUTC,
  ));
  const aeoDailyDone = publishedToday || autofiredToday;

  // 5a. Catchup missed AEO publish — at most once/day, only when overdue.
  if (autofire && overdue && !aeoDailyDone && (pendingAeo?.n || 0) > 0) {
    // The writer lives in the editorial plugin now; run it by tool name
    // (run_aeo_cron) through the shared pool — same return shape as the old
    // lib/aeo-writer.js runAeoCron call.
    const { runTool } = await import('../tools/index.js');
    // Stamp the attempt up front so concurrent / rapid-refocus wake-ups in the
    // same day can't each fire — one autofire per UTC day, success or not.
    // This stamp IS the once-per-day cap: the next tick reads it back as
    // aeoDailyDone. If it fails to PERSIST, we must NOT fire — a silent swallow
    // here is how a single overdue day turns into a runaway publish loop. So a
    // failed stamp aborts the fire instead of proceeding uncapped.
    let capStamped = false;
    try {
      await logEvent(env, { kind: EVENT_KINDS.AEO_AUTOFIRE, actor: 'wake-up', payload: { at: now } });
      capStamped = true;
    } catch (e) {
      console.error('aeo_autofire cap stamp failed — skipping autofire to avoid an uncapped publish loop:', e?.message || e);
      actions.push({ kind: 'aeo_publish', ok: false, label: 'Autofire skipped', detail: 'daily-cap stamp failed to persist' });
    }
    if (capStamped) try {
      // ready_only: only PUBLISH articles whose interview answers are already
      // in. Never auto-start an interview or queue a "I need your take" nag
      // from a background wake-up — the operator pulls those from the AEO UI
      // / explicit "draft now". Stops Nyo shoving interview prompts in chat.
      fired = await runTool(env, 'run_aeo_cron', { actor: 'wake-up-catchup', ready_only: true });
      if (fired?.ok) {
        actions.push({ kind: 'aeo_publish', ok: true, label: `Published "${fired.title}"`, detail: `${hoursSincePublish}h overdue → caught up`, ref: fired.blog_slug });
      } else {
        // "Nothing publishable" — every pending question is waiting on its
        // interview — is a NO-OP, not a failure. Reporting it as an action on
        // every single wake-up is exactly the spam we're killing here. Only a
        // REAL error (something actually tried to ship and broke) is an action.
        const reason = String(fired?.error || '').toLowerCase();
        const noop = !reason || /no pending|nothing to|needs? interview|interview|awaiting|no publishable|no question/.test(reason);
        if (noop) { cadenceBlocked = true; fired = null; }
        else actions.push({ kind: 'aeo_publish', ok: false, label: 'Tried to publish missed article — failed', detail: fired.error });
      }
    } catch (e) {
      fired = { ok: false, error: String(e?.message || e) };
      actions.push({ kind: 'aeo_publish', ok: false, label: 'Tried to publish missed article — failed', detail: fired.error });
    }
  }

  // 5b. Auto-retry recent outbox failures. Conservative — one auto-retry per
  // original failure, ever. If the retry also fails, the operator decides
  // whether to push harder via the Outbox UI.
  //   - parent_id IS NULL: only originals (skip rows that are themselves
  //     retries of something else)
  //   - NOT EXISTS child: no auto-retry has been attempted yet
  //   - created_at within the policy window: don't dig through ancient history on every wake
  //   - LIMIT (policy retry limit): don't blast the operator with 50 retries on a bad day
  if (autofire) {
    const retryCandidates = await safeAll(
      // NEVER auto-retry outreach channels (li = LinkedIn DMs/connects, social =
      // company/personal posts). A stale failure there re-sends a real message
      // to a real person on the next wake — exactly the incident where fixing
      // the DM endpoint made an old failed test DM to a 1st-degree connection
      // resurrect and deliver. Those channels own their own retry (the LI
      // campaign tick; social is operator-approved), so they're excluded here.
      // Auto-retry is only for transient operational sends (wa/blog).
      // Media sends are excluded for the same reason: a wa-gateway 500 raised
      // AFTER the media actually landed logged a false failure, and auto-retry
      // then delivered the same image to a real group over and over. A send we
      // cannot prove failed must never be re-fired automatically.
      `SELECT id, channel, kind, to_name, attempt FROM outbound_log o
        WHERE o.status = 'failed'
          AND o.channel NOT IN ('li', 'social')
          AND o.source != 'scheduled'   -- scheduled sends fail CLOSED, never auto-retry
          AND o.kind NOT IN ('image', 'video', 'audio', 'document')
          AND o.parent_id IS NULL
          AND o.created_at > ?
          AND NOT EXISTS (SELECT 1 FROM outbound_log r WHERE r.parent_id = o.id)
        ORDER BY o.created_at DESC
        LIMIT ?`,
      now - policy.outbox_window_hours * 3600 * 1000,
      policy.outbox_retry_limit,
    );
    for (const cand of retryCandidates) {
      const label = `${cand.channel} ${cand.kind} to ${cand.to_name || 'unknown'}`;
      try {
        await retryOutboxRow(env, cand.id);
        actions.push({ kind: 'outbox_retry', ok: true, label: `Retried ${label}`, ref: cand.id });
      } catch (e) {
        actions.push({ kind: 'outbox_retry', ok: false, label: `Retried ${label} — still failing`, detail: String(e?.message || e).slice(0, 120), ref: cand.id });
      }
    }
  }

  // 6. Compose the wake-up briefing.
  const lines = [`👋 **Morning.** Here's where we stand:`];
  if (lastPublish) {
    lines.push(`- Last article published: **${lastPublish.title}** (${hoursSincePublish}h ago).`);
  } else {
    lines.push(`- No articles published yet.`);
  }
  lines.push(`- AEO queue: ${pendingAeo?.n || 0} pending question${pendingAeo?.n === 1 ? '' : 's'}, ${failedAeo?.n || 0} failed.`);

  const failsByChannel = recentFails.map((r) => `${r.channel}=${r.n}`).join(', ');
  if (failsByChannel) {
    lines.push(`- Outbox failures (${policy.outbox_window_hours}h): ${failsByChannel}.`);
  } else {
    lines.push(`- Outbox: clean — no failed sends in the last ${policy.outbox_window_hours}h.`);
  }

  // What I actually did this wake-up.
  if (actions.length) {
    lines.push('');
    lines.push(`**What I did this wake-up:**`);
    for (const a of actions) {
      const icon = a.ok ? '✅' : '⚠️';
      const detail = a.detail ? ` — ${a.detail}` : '';
      lines.push(`- ${icon} ${a.label}${detail}`);
    }
  }

  // Cadence nudge — thoughtful + actionable, never a silent "tried & failed".
  if (cadenceBlocked) {
    lines.push('');
    lines.push(`⚠️ ${hoursSincePublish ?? '?'}h since the last publish (past our ${policy.cadence_hours}h cadence), but all ${pendingAeo?.n || 0} queued questions are waiting on an interview — so nothing auto-shipped. Open **AEO** or tell me "interview me" and I'll get the next one out.`);
  } else if (!actions.length && overdue && !autofire) {
    lines.push('');
    lines.push(`⚠️ It's been ${hoursSincePublish ?? '?'}h since the last publish — outside our ${policy.cadence_hours}h cadence. Run wake-up with \`autofire:true\` and I'll catch up.`);
  }

  // Trigger gate — the point of this rewrite: brief ONCE per distinct state,
  // not on every mount/refocus.
  //
  // We hash the *material* state into a signature (last publish, pending /
  // failed counts, overdue + cadence-blocked flags, outbox fails). If it
  // matches the signature of the briefing we last sent, the news is identical
  // → stay quiet. We re-brief when: (a) a real action was taken, (b) the
  // signature changed (new publish / failure / pending), or (c) a heartbeat
  // (policy hours) lapsed so a standing problem resurfaces once a day, not as
  // a flood. A null lastSig (first-ever brief, or a legacy event) counts as changed.
  const stateSig = [
    lastPublish?.slug || 'none',
    `p${pendingAeo?.n || 0}`,
    `f${failedAeo?.n || 0}`,
    overdue ? 'overdue' : 'ok',
    cadenceBlocked ? 'blocked' : '-',
    recentFails.map((r) => `${r.channel}:${r.n}`).sort().join(',') || 'noFails',
  ].join('|');

  const HEARTBEAT_MS     = policy.heartbeat_hours * 3600 * 1000;
  const actionTaken      = actions.length > 0;
  const stateChanged     = lastSig === null || lastSig !== stateSig;
  const heartbeatDue     = lastWakeUpAt > 0 && (now - lastWakeUpAt) >= HEARTBEAT_MS;
  const anythingToReport = actionTaken || stateChanged || heartbeatDue;
  const reason           = actionTaken ? 'action' : stateChanged ? 'changed' : 'heartbeat';

  // Hard once-per-gap cap on the CHAT MESSAGE (operator: "once a day, not 50
  // good-mornings"). State changes and auto-actions still happen and still log
  // to Activity/Workflows on capped ticks; we just don't queue another chat
  // briefing until the gap has passed. First-ever briefing is never capped.
  const BRIEFING_GAP_MS = policy.briefing_gap_hours * 3600 * 1000;
  const briefingCapped  = lastWakeUpAt > 0 && (now - lastWakeUpAt) < BRIEFING_GAP_MS;

  if (anythingToReport && !briefingCapped) {
    try {
      const msg = await queueNyoMessage(env, {
        kind:    'wake_up',
        content: lines.join('\n'),
        payload: {
          pending_aeo:     pendingAeo?.n || 0,
          failed_aeo:      failedAeo?.n  || 0,
          last_publish:    lastPublish || null,
          hours_since:     hoursSincePublish,
          outbox_fails:    recentFails,
          catchup_fired:   fired || null,
          cadence_blocked: cadenceBlocked,
          actions,
        },
      });
      await logEvent(env, {
        kind: 'nyo_wake_up_sent', actor: 'system',
        payload: { queued_id: msg.id, actions_n: actions.length, state_sig: stateSig, reason },
      });
      await logWorkflowRun(env, {
        workflow_slug: 'nyo-wake-up', status: 'succeeded',
        output: { queued: true, reason, actions_n: actions.length },
      }).catch(console.error);
      return { status: 200, body: { queued: true, message_id: msg.id, reason, fired, actions, summary: lines.join('\n') } };
    } catch (e) {
      await logWorkflowRun(env, {
        workflow_slug: 'nyo-wake-up', status: 'failed',
        error: String(e?.message || e), output: { queued: false, actions_n: actions.length },
      }).catch(console.error);
      return { status: 500, body: { queued: false, error: String(e?.message || e), fired, actions } };
    }
  }

  // Quiet tick: either same news as last time, or the once-per-gap briefing
  // cap is holding. Don't badge the operator for nothing — the trail lives in
  // the workflow run either way.
  const quietReason = briefingCapped && anythingToReport
    ? `briefing capped (once per ${policy.briefing_gap_hours}h)`
    : 'no change since last briefing';
  await logWorkflowRun(env, {
    workflow_slug: 'nyo-wake-up', status: 'succeeded',
    output: { queued: false, reason: quietReason, actions_n: actions.length },
  }).catch(console.error);
  return { status: 200, body: { queued: false, reason: quietReason, state_sig: stateSig, fired: null, actions } };
}
