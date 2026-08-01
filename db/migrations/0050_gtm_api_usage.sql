-- GTM enrichment API usage tracking (PDL / SerpApi / Twilio).
-- gtm_api_usage: our own count of billable calls per renewal period — always
-- works even when a provider reports nothing. warned_at latches the
-- once-per-period Nyo warning when usage crosses the configured threshold.
-- gtm_api_quota: the provider's own reported numbers (PDL response headers,
-- SerpApi /account, Twilio balance), cached at last capture so the UI can show
-- provider truth even when a live check fails.
CREATE TABLE IF NOT EXISTS gtm_api_usage (
  provider   TEXT NOT NULL,
  period     TEXT NOT NULL,             -- ISO date of the period's renewal anchor
  used       INTEGER NOT NULL DEFAULT 0,
  warned_at  INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, period)
);
CREATE TABLE IF NOT EXISTS gtm_api_quota (
  provider    TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,            -- JSON: whatever the provider reported
  captured_at INTEGER NOT NULL
);
