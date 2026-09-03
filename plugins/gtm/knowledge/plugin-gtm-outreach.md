# Outreach guide

The single control surface for how a first touch is argued. The angle generator
reads this whole note live, and the numbers in the block at the bottom are read
live by the sender and the conversation list.

## Strategy
What we are actually asking for on a first touch, and what we are not. Name the
one next step a good reply leads to.

## Language
Which language each kind of prospect gets, and any rule that overrides the
default (for example: always the prospect's own language when it is known).

## Rules
- Message length and the maximum number of bubbles in one touch.
- What may be claimed about the prospect's company, and what may not.
- Never name a person we have no record of: the prospect and the mutuals listed
  in the operator profile are the only people a draft may name.
- Banned phrases and punctuation.

## Exemplars
Paste two outreach messages you would send yourself, and one you would delete.
The generator imitates shape and register from these more than from adjectives.

## Self-check
The questions the draft must pass before it is shown: Is every fact sourced?
Would this read as automated? Is there exactly one ask?

## Numbers

`pacing` is the human gap between the bubbles of one message: a random wait
between `gap_min_ms` and `gap_min_ms + gap_jitter_ms`, scaled to the length of
the next bubble, never longer than `cap_ms`. `dead_after_days` is how many
silent days retire an unanswered conversation to DEAD in the list.

```json
{
  "pacing": { "gap_min_ms": 4000, "gap_jitter_ms": 5000, "cap_ms": 12000 },
  "dead_after_days": 21
}
```
