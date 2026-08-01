-- Daily Planner module — a persisted per-day plan produced by the planning
-- conversation, plus optional per-week strategic objectives.
--
-- daily_plans: one row per operator-local day (date = YYYY-MM-DD, resolved in the
-- KPI timezone). `plan` is the full plan JSON { summary, weekly_ref, schedule[],
-- todos[] }; `mode` is mirrored out for filtering ('strategic' = aligned to the
-- week's objectives, 'wing_it' = just get through the day). Shown automatically
-- for the current day, editable all day, searchable after.
CREATE TABLE IF NOT EXISTS daily_plans (
  date       TEXT PRIMARY KEY,                 -- YYYY-MM-DD (operator-local day)
  plan       TEXT NOT NULL,                    -- JSON: { mode, summary, weekly_ref, schedule:[], todos:[] }
  mode       TEXT NOT NULL DEFAULT 'wing_it',  -- 'strategic' | 'wing_it'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_plans_updated ON daily_plans (updated_at);

-- weekly_objectives: the strategic layer. One row per week (week_start = the
-- Sunday anchoring that week, matching the Sun–Thu work week + the Sunday Brain).
-- The strategic-mode daily plan aligns to the current week's row.
CREATE TABLE IF NOT EXISTS weekly_objectives (
  week_start TEXT PRIMARY KEY,                 -- YYYY-MM-DD (the week's Sunday)
  objectives TEXT NOT NULL,                    -- JSON: [{ id, text, done }]
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
