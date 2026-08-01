-- The angle moves from the PERSON to the COHORT.
--
-- A queue is a group of people who share a reason to be approached, so the
-- message sequence belongs to the queue and is written once, personalised per
-- recipient by variables ({first_name}, {company}, …) and by language variant.
-- Prospects no longer need their own generated angle to be queueable — that
-- requirement is what made most of a qualified list unusable.
--
-- Per-lead angles are NOT dropped: they still power the suggested reply in
-- Conversations, which is genuinely about one person. The queue just stops
-- depending on them.
--
-- sequence JSON:
--   { "default_language": "en",
--     "steps": [ { "delay_hours": 0,  "bodies": { "en": "...", "he": "..." } },
--                { "delay_hours": 72, "bodies": { "en": "..." } } ] }
-- delay_hours on step 0 is measured from go-live; on later steps from the
-- previous message actually being sent.
ALTER TABLE outreach_queues ADD COLUMN sequence TEXT;

-- NOTHING IS SCHEDULED BY EXISTING. Adding someone to a queue now stages them:
-- status 'staged', no next_send_at, invisible to the sender by construction
-- (the tick only ever selects status='active'). They become schedulable only
-- when the operator multi-selects them and presses go live, which is what sets
-- status='active' and computes the first send time.
--
-- Existing rows predate staging and were enrolled under the old
-- "enrol = scheduled" rule, so they keep their current status; there are none
-- in production at the time of writing.
UPDATE outreach_queue SET status = 'staged'
 WHERE status = 'active' AND next_send_at IS NULL;

-- When each person was approved to start receiving messages (NULL = staged).
ALTER TABLE outreach_queue ADD COLUMN approved_at INTEGER;
