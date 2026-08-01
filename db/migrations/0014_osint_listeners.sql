-- OSINT listeners table — separates the scraper engines from the monitoring
-- targets. Each listener row tracks enable/cadence/last-run state so the
-- operator can spin up sources gradually and Nyo can flip them on via chat.

CREATE TABLE IF NOT EXISTS osint_listeners (
  source        TEXT PRIMARY KEY,                 -- hn | reddit | stackoverflow | github | appstore | website | duckduckgo
  label         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,       -- 0/1
  cadence       TEXT NOT NULL DEFAULT 'manual',   -- manual | daily | hourly
  notes         TEXT,
  last_run_at   INTEGER,
  last_status   TEXT,                             -- ok | error | running
  last_error    TEXT,
  total_runs    INTEGER NOT NULL DEFAULT 0,
  total_added   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Seed the 7 sources. Start small — enable only the three lowest-friction
-- public APIs (HN, Reddit, DuckDuckGo). Operator can flip the others on
-- from Settings or via Nyo: "enable github listener".
INSERT OR IGNORE INTO osint_listeners (source, label, enabled, cadence, notes, created_at, updated_at) VALUES
  ('hn',            'Hacker News',          1, 'manual', 'Algolia search · keyless',                      unixepoch()*1000, unixepoch()*1000),
  ('reddit',        'Reddit',               1, 'manual', 'public search.json · keyless · throttled 2.2s', unixepoch()*1000, unixepoch()*1000),
  ('duckduckgo',    'DuckDuckGo (web)',     1, 'manual', 'html.duckduckgo.com · keyless · throttled 3.5s',unixepoch()*1000, unixepoch()*1000),
  ('stackoverflow', 'Stack Overflow',       0, 'manual', 'StackExchange search/excerpts API',             unixepoch()*1000, unixepoch()*1000),
  ('github',        'GitHub Issues',        0, 'manual', 'optional GITHUB_TOKEN for higher rate',         unixepoch()*1000, unixepoch()*1000),
  ('appstore',      'Apple App Store',      0, 'manual', 'RSS · needs target.app_id',                     unixepoch()*1000, unixepoch()*1000),
  ('website',       'Owned-site testimonials', 0, 'manual', 'probes /reviews, /testimonials, etc.',       unixepoch()*1000, unixepoch()*1000);
