-- Outreach · Queue — the prospects we have decided to approach, and the state
-- of the automated ladder for each. Plus the operator's manual "this
-- conversation is dead" marking, which is intent and therefore cannot be
-- derived from the messages.
--
-- Both tables are keyed by LEAD, not by chat id: WhatsApp can hand one person
-- several chat ids (a `@c.us` and an anonymised `@lid` twin), and a prospect
-- must never be enrolled twice or be dead on one id and alive on the other.
--
-- Nothing here schedules an LLM call. The ladder is the approved GTM angle's
-- own message bubbles, so every message that goes out is one the operator
-- already signed off in GTM -> Outreach.

-- One row per enrolled prospect. `step` indexes the angle's messages[].
-- answered_at is set the moment an inbound message is detected and is
-- PERMANENT — an answered prospect never receives an automated message again.
CREATE TABLE IF NOT EXISTS outreach_queue (
  lead_id        TEXT PRIMARY KEY,               -- gtm_leads.id
  chat_id        TEXT,                           -- DM id resolved at enrol time
  status         TEXT NOT NULL DEFAULT 'active', -- active | answered | paused | done | stopped
  step           INTEGER NOT NULL DEFAULT 0,     -- next bubble index in the angle
  next_send_at   INTEGER,                        -- ms epoch; NULL = unscheduled
  last_sent_at   INTEGER,
  last_sent_text TEXT,
  answered_at    INTEGER,                        -- set once, never cleared by the engine
  stop_reason    TEXT,                           -- answered | exhausted | failed | manual | opted_out
  last_error     TEXT,
  enrolled_at    INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outreach_queue_due    ON outreach_queue (status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_outreach_queue_status ON outreach_queue (status);

-- Operator intent about a conversation. Time-based death (no activity for N
-- days) is DERIVED at read time from the messages and is not stored here —
-- only an explicit mark is, so un-marking restores the real state.
CREATE TABLE IF NOT EXISTS outreach_conversation_state (
  lead_id     TEXT PRIMARY KEY,
  dead_at     INTEGER,                           -- NULL = not manually marked
  dead_reason TEXT,
  updated_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO knowledge_docs (slug, title, body, scope, module, parent_slug, updated_at) VALUES
('outreach-queue-cadence', 'Outreach · Queue cadence', 'Outreach · Queue — when automated follow-ups go out, and when a conversation is considered dead.

The ladder is NOT written here. It is the message bubbles of the top saved angle in GTM -> Outreach for that prospect: bubble 1 is the first touch, bubble 2 the first follow-up, and so on. When the bubbles run out the prospect leaves the queue as "exhausted". So every automated message is one you already approved — nothing writes new prose to a stranger unattended.

**A reply ends the automation, permanently.** Inbound messages are detected from the conversation itself, with no flag for anyone to remember, and the check runs again immediately before each send — so a follow-up queued days ago still aborts if they answered in the meantime.

**Live sending is gated.** Until the `outreach.live` feature flag is true, the queue runs in DRY RUN: it does everything except send, and logs exactly what it would have sent. Turn it on only once that log looks right.

`step_delays_hours` is the gap before each step, indexed from the FIRST follow-up (step 0 is the first touch and goes as soon as it is due). If there are more bubbles than delays, the last delay repeats.

Times are the operator''s working hours in `timezone`. `quiet_start_hour`/`quiet_end_hour` bracket the window sends are ALLOWED in; anything due outside it waits. `weekdays_only` skips Saturday and Sunday.

```json
{
  "step_delays_hours": [72, 96, 168],
  "max_sends_per_day": 20,
  "min_gap_minutes": 8,
  "quiet_start_hour": 9,
  "quiet_end_hour": 19,
  "weekdays_only": true,
  "timezone": "Asia/Jerusalem",
  "dead_after_days": 21
}
```

---
Rules of thumb when retuning the numbers above:

- Follow-ups get further apart, never closer. Three touches over two weeks reads as persistence; three over two days reads as desperation.
- `max_sends_per_day` is a whole-account cap, not per prospect. It is the number that stops a bad enrolment turning into a bulk send.
- `dead_after_days` only affects how conversations are FILTERED in the Conversations tab. It never sends anything and never deletes anything — a dead conversation can always be revived by marking it alive again.', 'global', NULL, 'module-outreach', strftime('%s','now')*1000);
