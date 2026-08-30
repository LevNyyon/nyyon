-- Daily Planner becomes a PLUGIN (the module-as-plugin pilot).
--
-- Its tables move into the plugin namespace — the plugin contract grants a
-- plugin exactly the plugin_<name>_* tables its own DDL creates, so the data
-- follows the module. Guarded copy: the legacy tables are created empty first
-- so this runs cleanly on fresh installs (nothing to copy) and on migrated
-- ones (data moves); INSERT OR IGNORE makes a re-run harmless.
CREATE TABLE IF NOT EXISTS daily_plans (
  date TEXT PRIMARY KEY, plan TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'wing_it',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS weekly_objectives (
  week_start TEXT PRIMARY KEY, objectives TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_daily_planner_plans (
  date TEXT PRIMARY KEY, plan TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'wing_it',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_daily_planner_objectives (
  week_start TEXT PRIMARY KEY, objectives TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO plugin_daily_planner_plans SELECT date, plan, mode, created_at, updated_at FROM daily_plans;
INSERT OR IGNORE INTO plugin_daily_planner_objectives SELECT week_start, objectives, created_at, updated_at FROM weekly_objectives;
DROP TABLE daily_plans;
DROP TABLE weekly_objectives;

-- The persona doc moves into the plugin knowledge namespace. Keep an edited
-- body if the operator has one; the guard means a doc already renamed (or
-- freshly seeded by the plugin) is left alone.
UPDATE knowledge_docs SET slug = 'plugin-daily-planner-persona'
WHERE slug = 'daily-planner-persona'
  AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug = 'plugin-daily-planner-persona');
DELETE FROM knowledge_docs WHERE slug = 'daily-planner-persona';
