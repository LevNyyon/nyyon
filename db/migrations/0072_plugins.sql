-- 0072 — Plugins: capabilities traded between nyyon-lite systems.
-- One row per plugin; the manifest is the source of truth, the applier
-- materializes its code files. Format: docs/plugin-format.md (v1).
CREATE TABLE IF NOT EXISTS plugins (
  name          TEXT PRIMARY KEY,   -- kebab-case install namespace
  version       TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,      -- imported|bound|materialized|active|blocked|removed
  manifest_json TEXT NOT NULL,
  binding_json  TEXT,               -- gateway binding decisions, verbatim
  report_json   TEXT,               -- last step's report (errors when blocked)
  installed_at  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugins_status ON plugins(status);
