-- "Queue" becomes "cohort" everywhere, including here. A queue is a line people
-- wait in; a cohort is a group who share a reason to be approached, which is
-- what these actually are and what the copy is written for. Leaving the old
-- word in the schema while every surface says cohort is the drift that costs
-- somebody an hour later.
ALTER TABLE outreach_queues RENAME TO outreach_cohorts;
ALTER TABLE outreach_queue  RENAME TO outreach_cohort_members;
ALTER TABLE outreach_cohort_members RENAME COLUMN queue_id TO cohort_id;

-- A cohort's own run state. This is not decoration: the sender skips any
-- cohort that is not `active`, so pausing or cancelling one stops every
-- scheduled message inside it at once, without touching the people.
--   active   — running
--   paused   — temporarily held; resumes where it left off
--   finished — everyone has been through the sequence
--   canceled — abandoned; will not run again
ALTER TABLE outreach_cohorts ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- Sending window, per cohort. NULL = inherit the account-wide default from the
-- cadence note, so an untouched cohort behaves exactly as it does today.
--   timezone  — IANA zone the send hours are measured in
--   send_days — JSON array of weekday numbers, 0=Sunday … 6=Saturday
--   languages — JSON array of language codes the sequence is authored in
ALTER TABLE outreach_cohorts ADD COLUMN timezone TEXT;
ALTER TABLE outreach_cohorts ADD COLUMN send_days TEXT;
ALTER TABLE outreach_cohorts ADD COLUMN languages TEXT;
ALTER TABLE outreach_cohorts ADD COLUMN start_hour INTEGER;
ALTER TABLE outreach_cohorts ADD COLUMN end_hour INTEGER;

CREATE INDEX IF NOT EXISTS idx_cohort_members_cohort ON outreach_cohort_members (cohort_id, status);
CREATE INDEX IF NOT EXISTS idx_cohorts_status ON outreach_cohorts (status);

-- The sequence JSON gains two per-step fields, both defaulted in code so old
-- rows keep working untouched:
--   channel — which surface the message goes out on. Only 'whatsapp' actually
--             sends today; the others are selectable but explicitly not wired.
--   trigger — the condition that decides whether the step fires at all:
--             'no_reply' (default — skip if they have answered), 'always'.
