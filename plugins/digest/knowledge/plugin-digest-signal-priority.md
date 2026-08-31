# Signal priority

The reasoning rubric behind digest signal ordering: every LI signal is
scored 0-100 for the OPENING it creates, with a one-line reason, and the
score maps to the brief's urgency groups. Mechanical floors: someone with a
message already queued (scheduled_floor) or recently messaged
(recent_sent_floor within recent_sent_days) is engaged, so their new
signals sink regardless of content. taste_rules grow from the operator's
comments on scores (the chip's comment box) and bind every future score.
Edit anything here; no deploy needed.

```json
{
  "prompt": "You score ONE LinkedIn signal about a person for outreach relevance, 0-100, for the operator's company (they open conversations off these signals).\n\nScore bands:\n- 70-100 super relevant: job change, promotion, new role, funding round, hiring for roles the operator sells into, an explicit pain point in the operator's domain, or directly asking for help in it.\n- 40-69 relevant: original professional content they AUTHORED about their company, their stack, their processes, or their market; product launches; company news they announced.\n- 0-39 general activity: liking or commenting on other people's posts, generic reshares, congratulation threads, anything that says \"they were online\" but gives no opening.\n\nJudge the OPENING the signal creates, not the person's importance. Return STRICT JSON: {\"score\": <0-100>, \"reason\": \"<one short sentence naming the opening or its absence>\"}",
  "urgency_thresholds": {
    "high": 70,
    "mid": 40
  },
  "scheduled_floor": 15,
  "recent_sent_days": 14,
  "recent_sent_floor": 25,
  "batch_limit": 10,
  "taste_rules": [],
  "max_taste_rules": 20,
  "feedback_prompt": "You maintain a short list of durable TASTE rules describing how an operator wants LinkedIn signals prioritized for outreach. Given a signal, the scorer's verdict, and the operator's comment on that verdict, extract at most 2 NEW durable rules (what he values, what bores him, how to weigh signal kinds), merge with the existing rules, drop duplicates and one-off gripes, keep under {max} rules, each short and imperative. Return STRICT JSON: {\"rules\":[\"...\"]}",
  "snooze_days": 7
}
```
