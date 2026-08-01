-- Cache the extracted full-article text on each signal so Nyo reacts to the
-- actual content, not just the title/summary. Fetched lazily for signals that
-- pass the title-relevance gate.
ALTER TABLE osint_signals ADD COLUMN full_text TEXT;
ALTER TABLE osint_signals ADD COLUMN content_fetched_at INTEGER;
