-- LI Outreach funnel: persist acceptance + reply per prospect.
-- accepted_at is written by the funnel check when a sent invitation disappears
-- from LinkedIn's pending list (or definitively when a DM succeeds).
-- replied_at is set by the operator/Nyo (mark-reply) until an automated
-- messenger read becomes available again (the legacy conversations API is dead).
ALTER TABLE li_prospects ADD COLUMN accepted_at INTEGER;
ALTER TABLE li_prospects ADD COLUMN replied_at INTEGER;
