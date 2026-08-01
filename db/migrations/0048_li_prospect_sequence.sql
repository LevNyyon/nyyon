-- Per-prospect sequence override for LI Outreach.
--
-- By default a prospect follows the global li-outreach-sequence knowledge doc.
-- When the operator customizes the flow for ONE lead, that lead's own step list
-- is snapshotted here (same shape as the global steps: connect/message hold a
-- generation `prompt`, wait holds `days`). NULL = follow the global sequence.
-- The tick reads this per prospect; editing it never touches other leads.

ALTER TABLE li_prospects ADD COLUMN sequence_json TEXT;
