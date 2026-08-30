# Heartbeat priorities

The quality gates the awareness sweep applies. Raise a number to let less
through; lower it to see more and sort by hand. The code reads the JSON block
live, so a change takes effect on the next sweep.

- `digest_min_content` — the content score a signal needs to reach the morning
  brief.
- `topics_min_content` — the floor for a signal to be considered when
  synthesizing topics.
- `enrich_min_relevance` — the relevance score that earns a signal a full
  article fetch and re-score. This one costs money; raise it first if the
  enrichment bill is high.

```json
{
  "digest_min_content": 70,
  "topics_min_content": 62,
  "enrich_min_relevance": 60
}
```
