# WhatsApp send slots

The scheduling choices a Digest card offers next to ASAP: one morning and
one evening slot per day, for the next days_ahead days, in the configured
timezone. Times are wall-clock HH:MM. The slot clock follows the RECIPIENT:
longest phone-prefix match in tz_by_prefix wins; no match falls back to
`timezone`. hold=true pauses queued sending (cards fall back to manual
wa.me links).

```json
{
  "days_ahead": 7,
  "morning": "09:30",
  "evening": "19:30",
  "timezone": "Asia/Jerusalem",
  "tz_by_prefix": {
    "1": "America/New_York",
    "972": "Asia/Jerusalem",
    "44": "Europe/London"
  },
  "hold": false
}
```
