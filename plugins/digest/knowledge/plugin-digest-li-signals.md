How LinkedIn signals surface in the Digest feed. The sync reads the JSON
below at run time — edit here, no deploy. urgency: 1 high / 2 medium / 3 low
per signal kind. actions: the suggested-action wording (with_phone wins when
the person has a known WhatsApp number). The channel is DORMANT until the
host carries an li_signals feed (a LinkedIn signal scanner writes it).

```json
{
  "lookback_days": 3,
  "max_per_run": 20,
  "urgency": {
    "open_role": 1,
    "job_change": 2,
    "post": 2,
    "news": 3
  },
  "actions": {
    "with_phone": "Message them on WhatsApp",
    "open_role": "Reach out about the role",
    "job_change": "Congratulate and open the door",
    "post": "Reply to their post",
    "news": "Open with the news"
  },
  "kind_labels": {
    "open_role": "hiring",
    "job_change": "job change",
    "post": "post",
    "news": "news"
  }
}
```
