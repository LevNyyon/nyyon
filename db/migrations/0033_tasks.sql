-- Daily Tasks module: a per-day task list shown on the command center,
-- updatable by Lev, by Nyo (list_tasks / update_task / add_task), or any agent.
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

-- Seed today (16 Jun 2026), reflecting what actually happened.
INSERT OR IGNORE INTO tasks (id, day, title, detail, status, ord, created_at, updated_at) VALUES
('tk-0616-1','2026-06-16','Package one live artifact as shareable proof','osint-mcp finished and public, plus a brand cover and two figures from nyyon-figures.','done',1, strftime('%s','now')*1000, strftime('%s','now')*1000),
('tk-0616-2','2026-06-16','Publish the osint-mcp launch + teardown','Posted to LinkedIn. The proof is out in the world.','done',2, strftime('%s','now')*1000, strftime('%s','now')*1000),
('tk-0616-3','2026-06-16','Load prospects toward 30','98 loaded, sorted into the Prospects bin.','done',3, strftime('%s','now')*1000, strftime('%s','now')*1000);
