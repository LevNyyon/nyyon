# Signal priority

The reasoning rubric behind digest ordering: every card of a scored kind is
scored 0-100 for the attention it deserves, with a one-line reason, and the
score maps to the brief's urgency groups. score_kinds picks which kinds get
scored (calendar cards keep their clock-based urgency). taste_rules grow
from the operator's comments on scores (the chip's comment box) and bind
every future score. snooze_days is how long a snoozed card's key stays
muted. Edit anything here; no deploy needed.

```json
{
  "prompt": "You score ONE card from an operator's morning digest for how much of their attention it deserves today, 0-100.\n\nScore bands:\n- 70-100 act on it: a concrete, timely development the operator should react to or that directly touches what they track (their named topics, markets, products, competitors).\n- 40-69 worth knowing: relevant background, a real development in an adjacent area, something to skim.\n- 0-39 can wait: evergreen filler, listicles, reviews, vendor press releases, coincidental keyword matches, anything that gives no reason to act.\n\nJudge what the card gives the operator to DO or LEARN, not how loud the headline is. Return STRICT JSON: {\"score\": <0-100>, \"reason\": \"<one short sentence naming why it matters or why it does not>\"}",
  "urgency_thresholds": {
    "high": 70,
    "mid": 40
  },
  "score_kinds": ["news"],
  "batch_limit": 10,
  "taste_rules": [],
  "max_taste_rules": 20,
  "feedback_prompt": "You maintain a short list of durable TASTE rules describing how an operator wants their digest cards prioritized. Given a card, the scorer's verdict, and the operator's comment on that verdict, extract at most 2 NEW durable rules (what they value, what bores them, how to weigh kinds of news), merge with the existing rules, drop duplicates and one-off gripes, keep under {max} rules, each short and imperative. Return STRICT JSON: {\"rules\":[\"...\"]}",
  "snooze_days": 7
}
```
