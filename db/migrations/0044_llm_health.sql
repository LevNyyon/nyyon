-- LLM credit circuit-breaker state (one row). "Our LM" = the primary reasoning
-- provider (Anthropic). When it runs out of credit / rejects the key, the
-- circuit opens: chat + light jobs fall back to the local Qwen, heavy writers
-- pause, and the operator is alerted. It closes automatically when Anthropic
-- answers again. See workers/api/src/lib/llm.js.
CREATE TABLE IF NOT EXISTS llm_health (
  id         TEXT PRIMARY KEY,        -- always 'primary'
  status     TEXT NOT NULL DEFAULT 'ok',   -- ok | down
  reason     TEXT,                    -- credit | auth
  since      INTEGER,                 -- ms epoch the circuit opened
  last_error TEXT,
  last_check INTEGER,                 -- ms epoch of the last probe
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO llm_health (id, status, updated_at)
VALUES ('primary', 'ok', strftime('%s','now')*1000);
