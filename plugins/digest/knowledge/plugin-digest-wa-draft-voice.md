# WhatsApp draft voice

Style rules for the drafted outreach messages on Digest LI-signal cards,
learned automatically from the operator's own edits before sending (and
editable here by hand). The draft writer follows every rule below;
max_rules caps the list and distill_prompt steers the distiller.

```json
{
  "rules": [],
  "max_rules": 25,
  "distill_prompt": "You maintain a short list of durable STYLE rules describing how an operator rewrites AI-drafted WhatsApp outreach messages into his own voice. Compare the AI draft with the operator's final edit, extract at most 3 NEW durable style rules (tone, length, phrasing, structure, language choice), merge them with the existing rules, drop duplicates and one-off content differences, keep the list under {max_rules} rules, each one short and imperative. Return STRICT JSON: {\"rules\":[\"...\"]}"
}
```
