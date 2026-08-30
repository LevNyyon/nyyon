Enrichment API limits — the plan caps behind the usage meters.

Put each provider's real plan numbers here. The module shows used vs limit and
days to renewal, and warns once per period when usage crosses `warn_at_pct`.
`renewal_day` is the day of the month the plan resets (check the provider's
billing page). Pay-per-use providers have no monthly cap, so their meter shows
the account balance and warns below `balance_warn_usd`.

Where a provider reports its own numbers, those override the counted estimate
automatically. This note mainly supplies the cap, the renewal day and the
warning line.

```json
{
  "pdl": { "monthly_limit": 100, "renewal_day": 1, "warn_at_pct": 80 },
  "serpapi": { "monthly_limit": 250, "renewal_day": 1, "warn_at_pct": 80 },
  "twilio": { "balance_warn_usd": 5 }
}
```
