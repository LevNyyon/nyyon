# Lead heat

How warm a lead is, 0-100, from what actually happened between us: replies
and accepted connections weigh most, live WhatsApp conversation next, their
LinkedIn activity and our own engagement least. Heat decays when nothing has
happened for stale_after_days (never below stale_floor of the raw score).
hot_at / warm_at set where the bar changes colour. Edit any weight here; no
deploy needed.

```json
{
  "replied": 45,
  "connected": 18,
  "invited": 4,
  "inbound_each": 9,
  "inbound_max": 27,
  "our_message_each": 3,
  "our_message_max": 9,
  "signal_each": 4,
  "signal_max": 16,
  "we_engaged": 6,
  "engaged_each": 10,
  "engaged_max": 30,
  "stale_after_days": 21,
  "stale_floor": 0.45,
  "hot_at": 60,
  "warm_at": 30
}
```
