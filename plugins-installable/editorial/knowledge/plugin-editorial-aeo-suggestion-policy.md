How many OSINT-sourced article suggestions land in the AEO queue per day, and the minimum signal quality to be eligible. The code (`loadSuggestionPolicy` in the editorial plugin's aeo-suggestions lib) reads the JSON block below at run time — edit here or in Settings, no deploy.

- `daily_limit` — new suggestions generated per daily cron tick
- `max_pending` — hard cap on the unreviewed pile; generation skips once this many are already awaiting your decision
- `min_content_score` — signal eligibility floor (content_score from the heartbeat scorer)

```json
{
  "daily_limit": 2,
  "max_pending": 5,
  "min_content_score": 65
}
```
