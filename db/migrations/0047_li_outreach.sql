-- LI Outreach module — LinkedIn first-touch sequences (nyyon-lite).
--
-- li_prospects: one row per person an outreach sequence touches. step_index
-- always points at the NEXT ACTION step in the li-outreach-sequence knowledge
-- doc (wait steps are consumed when a send advances the pointer and become
-- next_action_at). The sequence + throttling rules live in knowledge docs
-- (li-outreach-sequence, li-outreach-throttle), NOT here — editing the doc
-- changes behavior with no deploy.
--
-- li_touches: the permanent per-prospect action log (what was sent, when,
-- sent/failed + error). The Outreach tab's per-prospect timeline reads this.
--
-- Global play/stop is the feature flag `li_outreach_paused` (feature_flags),
-- per-prospect play/stop is li_prospects.status.

CREATE TABLE IF NOT EXISTS li_prospects (
  id             TEXT PRIMARY KEY,             -- lp_<rand>
  urn_id         TEXT UNIQUE,                  -- voyager urn id (search result; DM target)
  public_id      TEXT,                         -- profile slug (connect target; resolved lazily at send time)
  name           TEXT NOT NULL,
  role           TEXT,                         -- jobtitle from search / profile
  company        TEXT,
  circle         INTEGER,                      -- connection degree 1/2/3 (search `distance`)
  location       TEXT,
  status         TEXT NOT NULL DEFAULT 'active',  -- active | paused | done | stalled
  step_index     INTEGER NOT NULL DEFAULT 0,   -- next ACTION step in the sequence doc
  next_action_at INTEGER,                      -- ms epoch; NULL = due now
  fail_count     INTEGER NOT NULL DEFAULT 0,   -- consecutive failures at the current step
  source_search  TEXT,                         -- the pasted search this came from
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_li_prospects_due    ON li_prospects (status, next_action_at);
CREATE INDEX IF NOT EXISTS idx_li_prospects_status ON li_prospects (status);

CREATE TABLE IF NOT EXISTS li_touches (
  id          TEXT PRIMARY KEY,                -- lt_<rand>
  prospect_id TEXT NOT NULL,
  step_index  INTEGER NOT NULL,
  kind        TEXT NOT NULL,                   -- connect | message
  body        TEXT,                            -- the rendered note / message actually sent
  status      TEXT NOT NULL,                   -- sent | failed
  error       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_li_touches_prospect ON li_touches (prospect_id, created_at);
CREATE INDEX IF NOT EXISTS idx_li_touches_day      ON li_touches (status, kind, created_at);
