# Hot Takes — source scout (first run)

How the module's one-time setup proposes what to watch. The procedure lives
here, not in code: edit this note and the next first run behaves differently
with no deploy.

## What the scout is for

A fresh install watches the feeds that shipped with it. That is somebody else's
industry. This scout reads what setup already learned about the operator, asks
the model who actually publishes in their world, and then PROVES each answer by
fetching it. Nothing that failed to fetch and parse is ever offered.

## What it reads first

`company-profile`, `icp`, `pov-library` and `plugin-editorial-heartbeat-priorities`.
If those are still the shipped placeholders the scout must say so plainly and
ask the operator for one line about what they do and who it is for, rather than
proposing a generic industry. Guessing here is how an install ends up watching
the wrong market confidently.

## What it asks for

- **Feeds** — real RSS/Atom URLs from publications, trade press, associations,
  research groups and notable company blogs in the operator's field. Prefer
  publications that post several times a week. A feed URL the model is unsure
  of should still be offered WITH the site's homepage, so the scout can probe
  the conventional paths itself.
- **Topics** — Google News queries in the operator's language of trade: named
  companies, named technologies, named regulations. Queries beat adjectives.
- **Brands and competitors** — the operator's own names, and the handful of
  rivals worth a standing listener.
- **Keywords and an ignore list** — the words that make an item theirs, and the
  neighbouring subject that keeps showing up and never matters.

## The rules the scout obeys

1. Never offer a feed that was not fetched and parsed. Report the item count.
2. Never offer a source that is already being watched.
3. A guess about a URL is fine to ATTEMPT and never fine to present.
4. Everything is optional. An operator who skips gets an empty module that
   works, not a broken one.

## Tunables

`candidate_feeds` / `candidate_topics` size the ask. `max_validations` is the
fetch ceiling for one proposal run (it bounds the worker's subrequest budget).
`min_items` is how many parsed entries a feed needs before it counts as alive.
`probe_paths` are the conventional feed paths tried when the model's URL misses,
capped by `max_probe_paths`. `placeholder_markers` are the phrases that identify
a knowledge note still carrying its shipped placeholder text.

```json
{
  "candidate_feeds": 12,
  "candidate_topics": 6,
  "max_validations": 26,
  "validate_timeout_ms": 9000,
  "max_feed_bytes": 400000,
  "min_items": 2,
  "probe_paths": [
    "/feed",
    "/rss",
    "/feed.xml",
    "/rss.xml",
    "/atom.xml",
    "/index.xml"
  ],
  "max_probe_paths": 3,
  "themes": [
    "general",
    "industry",
    "competitor",
    "brand",
    "market",
    "technology"
  ],
  "placeholder_markers": [
    "REQUIRED.",
    "Replace the placeholders",
    "Replace every\nline below",
    "Replace with your own subject matter",
    "The quality gates the awareness sweep applies",
    "Nothing captured yet"
  ],
  "min_personal_chars": 200
}
```
