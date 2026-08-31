When the Digest raises a "system needs you" card. Edit the JSON, no deploy.
- pool_min_queued: alert when fewer LI prospects are queued for connects
  (0 = check off; this install's pool statuses may not use 'queued').
- articles_min / articles_window_days: alert when fewer articles are
  scheduled inside the window (reads the editorial pack's hot-take packages).

```json
{
  "pool_min_queued": 0,
  "articles_min": 2,
  "articles_window_days": 5
}
```
