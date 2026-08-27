-- Daily Tasks module: a per-day task list shown on the command center,
-- updatable by the operator, by Nyo (list_tasks / update_task / add_task), or any agent.
CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  day        TEXT NOT NULL,                         -- YYYY-MM-DD
  title      TEXT NOT NULL,
  detail     TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',       -- pending | doing | done | drafted | skipped
  ord        INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_day ON tasks(day);

-- Seed data removed for the shipped product (the task list starts empty).
