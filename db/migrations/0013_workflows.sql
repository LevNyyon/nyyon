-- 0013 — Workflows module.
-- A workflow stitches existing modules + crons into a named pipeline:
--   trigger (event or cron) -> ordered steps -> side effects in other modules.
-- This migration ships VISIBILITY only — every workflow already running in the
-- system today is hardcoded; we surface it here as a row so the operator can
-- see "what fires when". Future workflows authored by Nyo land in the same table
-- and (Phase 2) a runtime will execute them.
--
-- Tables:
--   workflows           — definition (trigger JSON + steps JSON + source)
--   workflow_runs       — one row per fire (status, started/finished, trigger payload)
--   workflow_step_runs  — per-step trail for runtime-executed workflows (Phase 2)

CREATE TABLE IF NOT EXISTS workflows (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  trigger      TEXT NOT NULL,                       -- JSON: { kind, ...filter }
  steps        TEXT NOT NULL,                       -- JSON array of step defs
  source       TEXT NOT NULL DEFAULT 'nyo',         -- system | nyo | manual
  status       TEXT NOT NULL DEFAULT 'active',      -- active | draft | disabled
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   TEXT,
  updated_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_source ON workflows(source);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id              TEXT PRIMARY KEY,                 -- wr_<rand>
  workflow_slug   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',  -- running | succeeded | failed
  trigger_kind    TEXT,
  trigger_payload TEXT,                             -- JSON
  output          TEXT,                             -- JSON: summary of result
  error           TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_slug       ON workflow_runs(workflow_slug);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_started_at ON workflow_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status     ON workflow_runs(status);

-- Step-by-step trail. Only populated by the Phase-2 runtime for data-driven
-- workflows; hardcoded system workflows skip this and just log the final run.
CREATE TABLE IF NOT EXISTS workflow_step_runs (
  id            TEXT PRIMARY KEY,                   -- wsr_<rand>
  run_id        TEXT NOT NULL,
  step_index    INTEGER NOT NULL,
  step_name     TEXT,
  step_type     TEXT,                               -- llm | tool | wait
  input         TEXT,                               -- JSON
  output        TEXT,                               -- JSON
  status        TEXT NOT NULL DEFAULT 'running',
  error         TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workflow_step_runs_run ON workflow_step_runs(run_id);

-- ─── seed: the two workflows already wired into the system today ───────────
INSERT OR REPLACE INTO workflows (slug, name, description, trigger, steps, source, status, created_at, updated_at, created_by)
VALUES (
  'aeo-daily-writer',
  'AEO daily writer',
  'Each day at 06:00 UTC, pick the highest-priority pending AEO question, read Nyyon brand voice + AEO playbook + recent posts, draft an article via OpenAI gpt-5.5, publish straight to blog_posts, and mark the question published. Hardcoded today in lib/aeo-writer.js — surfaced here for visibility.',
  json('{"kind":"cron","schedule":"0 6 * * *","timezone":"UTC"}'),
  json('[
    {"type":"db","name":"Pick next pending question","action":"nextPendingAeoQuestion","out":"question"},
    {"type":"db","name":"Read brand voice + playbook + recent posts","action":"loadAeoContext","out":"context"},
    {"type":"llm","name":"Draft article in Nyyon voice","model":"openai/gpt-5.5","prompt":"build via buildUserPrompt() in aeo-writer.js","out":"draft"},
    {"type":"db","name":"Ensure slug uniqueness","action":"ensureUniqueSlug","out":"slug"},
    {"type":"tool","name":"Publish to blog","tool":"write_blog_post","input":"draft fields, published=1"},
    {"type":"db","name":"Mark question published","action":"markAeoQuestionPublished"}
  ]'),
  'system',
  'active',
  strftime('%s','now') * 1000,
  strftime('%s','now') * 1000,
  'system-seed'
);

INSERT OR REPLACE INTO workflows (slug, name, description, trigger, steps, source, status, created_at, updated_at, created_by)
VALUES (
  'blog-to-calendar-mirror',
  'Blog → Calendar mirror',
  'Every time a blog post is saved with published=1, upsert a matching calendar_event (kind=blog_publish, all_day, status=done if past / confirmed if future). Hardcoded today as a hook inside writeBlogPost — surfaced here for visibility.',
  json('{"kind":"event","event":"blog_post_published"}'),
  json('[
    {"type":"tool","name":"Upsert calendar event","tool":"write_calendar_event","input":"{kind:blog_publish, title, description=excerpt, starts_at=published_at, all_day:true, source:blog, source_ref:slug, link_url:/blog/<slug>}"}
  ]'),
  'system',
  'active',
  strftime('%s','now') * 1000,
  strftime('%s','now') * 1000,
  'system-seed'
);

-- ─── module registry entry ──────────────────────────────────────────────────
INSERT OR REPLACE INTO modules (slug, name, status, description, surface, created_at, updated_at)
VALUES (
  'workflows',
  'Workflows',
  'shipped',
  'Stitches existing modules + crons into named pipelines. Visibility-only in v1: lists every workflow (hardcoded system ones + Nyo-authored ones) and their run history. Phase 2 will add a runtime that executes data-driven workflows.',
  'workflows',
  strftime('%s','now') * 1000,
  strftime('%s','now') * 1000
);
