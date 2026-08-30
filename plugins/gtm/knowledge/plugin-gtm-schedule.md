Scheduled sends — the rules the scheduler reads live.

A scheduled send fires on a cron tick, so the actual send lands at the FIRST
tick at or after the scheduled time: it can be up to ~40 minutes late, never
early. Duplicates are structurally blocked (one live schedule per prospect and
content, atomic claim, fail-closed, no automatic retry). A claimed or failed row
is an operator decision, not a retry queue.

- `max_horizon_days` — how far ahead a send may be scheduled.
- `default_send_hour` + `default_days_ahead` — what the schedule picker offers
  first (12 + 0 = the next noon, rolling to tomorrow once noon has passed).
- `default_jitter_minutes` — random minutes added so send times are never flat.
- `timezone` — the wall clock the presets and every displayed time use (IANA
  name), wherever the operator's browser happens to be.

```json
{
  "max_horizon_days": 30,
  "default_send_hour": 12,
  "default_days_ahead": 0,
  "default_jitter_minutes": 9,
  "timezone": "UTC"
}
```
