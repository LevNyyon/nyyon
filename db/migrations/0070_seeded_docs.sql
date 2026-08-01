-- Which knowledge docs on this install are still the ones that SHIPPED.
--
-- WHY THIS EXISTS
-- Half the product steers on the operator's own words: the article writer reads
-- `brand-voice`, social drafting reads `personal-voice`, Hot Takes argues from
-- `pov-library`, the awareness sweep gates on `heartbeat-priorities`. A fresh
-- install has all of those — as PLACEHOLDERS the seed wrote, which say "replace
-- this" and read, in every draft, like nobody. So every module that writes has
-- to be able to answer one question before it opens: "is this document the
-- operator's, or is it still ours?"
--
-- The obvious answer — look for the placeholder's wording — is the wrong one.
-- That is a string match against prose in another file, and prose gets reworded.
-- The day somebody improves the seed's copy, every check silently starts
-- reporting the operator's own writing as a shipped default (or the reverse),
-- with nothing failing loudly enough to notice.
--
-- So the seed STAMPS what it shipped. For every doc it emits it also records a
-- fingerprint (SHA-256 of the exact body) here. "Still the default" is then a
-- fact, not a guess: hash the doc as it stands now and compare.
--
--   fingerprint matches  → nobody has touched it; it is the shipped placeholder
--   fingerprint differs  → somebody wrote it (the setup interview, Nyo, or the
--                          operator editing it in Knowledge). It is theirs.
--   no row / no doc      → nothing was ever shipped or nothing is there. A
--                          missing doc is not the operator's either.
--
-- The stamp is a property of what the SEED SHIPPED, never of what is in the
-- doc row, which is what makes it survive every ordering: a re-run of the seed
-- leaves an edited doc alone (ON CONFLICT DO NOTHING) and rewrites this
-- fingerprint to the placeholder's — so the edited doc still reads as the
-- operator's. `--overwrite-docs` restores the placeholder AND its matching
-- fingerprint, so it correctly reads as a default again.
--
-- Fail-soft like install_state: a missing table means "nothing was ever
-- stamped", never an error.
CREATE TABLE IF NOT EXISTS seeded_docs (
  slug        TEXT PRIMARY KEY,
  -- SHA-256 of the shipped body, lowercase hex. Computed by scripts/seed-app.mjs
  -- at generation time and re-computed by lib/module-prereqs.js at read time.
  fingerprint TEXT NOT NULL,
  seeded_at   INTEGER NOT NULL
);
