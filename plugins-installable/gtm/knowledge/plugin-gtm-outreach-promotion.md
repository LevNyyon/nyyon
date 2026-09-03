Outreach replies → pipeline — how an answered outreach becomes a deal.

When someone replies to our LinkedIn outreach or our GTM WhatsApp outreach, the
`outreach-replies-to-pipeline` workflow pulls them in and puts them on the sales
board. A brand-new person is created as a `prospect` client at `replied_stage`;
someone already on the board is advanced to `replied_stage` — but only forward:
with `advance_only`, a deal already at (say) `offer-sent` is left where it is, we
never drag it back to `lead` just because a message came in.

`stage_rank` is the board order used to decide "forward". `tag` is stamped on the
client and contact so replied-driven entries are filterable. Matching to an
existing record is by: the GTM lead's linked client, then a contact with the same
phone or LinkedIn URL, then a client whose name matches — so re-running never
duplicates anyone.

```json
{
  "replied_stage": "lead",
  "advance_only": true,
  "stage_rank": [
    "target",
    "lead",
    "talking",
    "discovery",
    "offer-sent",
    "reviewing",
    "won"
  ],
  "tag": "replied"
}
```
