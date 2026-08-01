-- Outreach · Cohorts — per-message approval, and per-message edits.
--
-- Until now the only gate was go-live: approving a PERSON scheduled their whole
-- ladder, and every later step went out unattended. That is the right shape for
-- a trusted sequence and the wrong one for the operator who wants to read each
-- message before it leaves. These columns make approval per (person, step)
-- instead of per person.
--
-- WHY A STEP INDEX AND NOT A BOOLEAN: a boolean would stay true after the step
-- advanced, so approving message 1 would silently also approve messages 2 and 3.
-- Storing WHICH step was approved means the match `approved_step = step` breaks
-- by itself the moment a send moves the member forward — the next message is
-- un-approved by construction, not because something remembered to clear a flag.
ALTER TABLE outreach_cohort_members ADD COLUMN approved_step INTEGER;
ALTER TABLE outreach_cohort_members ADD COLUMN approved_step_at INTEGER;

-- The operator's edit of ONE message for ONE person, made inline in the sheet.
-- Also carries its step, and for the same reason: an edit to message 1 must not
-- silently become the text of message 2. When `override_step` no longer matches
-- the member's `step`, the override is spent and the cohort's own copy is used.
--
-- The cohort's sequence is NOT modified by this — an edit here is for this
-- person only, and the group's copy stays what was authored for the group.
ALTER TABLE outreach_cohort_members ADD COLUMN override_text TEXT;
ALTER TABLE outreach_cohort_members ADD COLUMN override_step INTEGER;

-- The sender selects on (status, next_send_at) and now also reads approval;
-- keeping approval in the same index avoids a second lookup per due row.
CREATE INDEX IF NOT EXISTS idx_cohort_members_approval
  ON outreach_cohort_members (status, next_send_at, approved_step);
