-- Module first-run state — "has the operator been walked through this module yet".
--
-- WHY A TABLE AND NOT A KNOWLEDGE NOTE
-- A knowledge note is an editable RULE the code reads on every run (a prompt, a
-- threshold, a list). This is not a rule, it is a fact about this install: a
-- timestamp and a one-time decision. Putting it in knowledge_docs would drop a
-- non-editable status row into the Knowledge tree next to the notes that ARE
-- meant to be edited, and an operator who "tidied" it away would silently
-- reopen the wizard. So it lives where install_state lives: a small state table
-- with the same shape and the same fail-soft discipline (a missing table means
-- "not set up yet", never an error).
--
-- One row per module slug. `status` is the operator's decision, not progress:
--   'done'    — they went through it and applied something
--   'skipped' — they closed it deliberately; the module must still work, empty
-- Either value stops the first-run surface from opening again unattended. There
-- is no 'pending' row: absence IS pending.
--
-- `summary` is a JSON receipt of what the run actually did (sources added,
-- targets added, whether the first ingest ran) so the module can show "set up
-- on <date>, added N sources" without re-deriving it from the activity bus.
CREATE TABLE IF NOT EXISTS module_setup (
  module       TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'done',
  completed_at INTEGER NOT NULL,
  actor        TEXT,
  summary      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
