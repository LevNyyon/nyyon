Outreach · queue cadence — the pacing rules the sending engine reads live.

- `step_delays_hours` — how long to wait before each FOLLOW-UP. Step 0 is the
  first touch and goes as soon as it is due. Fewer entries than steps means the
  last value repeats.
- `max_sends_per_day` / `min_gap_minutes` — the volume ceiling and the minimum
  spacing between two sends, so a queue never bursts.
- `quiet_start_hour` / `quiet_end_hour` / `weekdays_only` / `timezone` — the
  window in which sending is allowed, in the operator's local clock.
- `dead_after_days` — when a silent conversation stops being followed up.
- `require_approval` — when true (the default and the safe direction) every
  individual message waits for a human press before it goes.
- `max_message_chars` — ceiling on a hand-written message.

```json
{
  "step_delays_hours": [72, 96, 168],
  "max_sends_per_day": 8,
  "min_gap_minutes": 20,
  "quiet_start_hour": 9,
  "quiet_end_hour": 19,
  "weekdays_only": true,
  "timezone": "UTC",
  "dead_after_days": 21,
  "require_approval": true,
  "max_message_chars": 4000
}
```

---
**Why these numbers start low.** A brand-new install is a brand-new WhatsApp
number, and unwarmed numbers are the ones that get banned. The reference
install lost an account to 19 cold messages, 16 of them inside 100 seconds —
so the spacing rule matters more than the daily ceiling, and both ship
deliberately conservative. 8 a day with 20 minutes between them is a floor to
raise once an account has history, not a target to hit on day one.

Raise them slowly, and only after the number has been sending and RECEIVING
normal conversation for a while. Nothing here protects an account that is
blasting strangers; it only keeps an honest queue from looking like a bot.

Notes for whoever runs the queue: write down here why the numbers above are what
they are, so the next person does not "optimise" them back.
