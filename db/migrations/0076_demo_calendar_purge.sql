-- The last pre-purge demo content: 0012 used to seed two example calendar
-- events on EVERY fresh install, which the digest's opportunity pull then
-- faithfully surfaced as "results" on day zero. The seed is deleted from
-- 0012; this cleans installs that already ran it.
DELETE FROM calendar_events WHERE id LIKE 'ce_demo_%';
DELETE FROM plugin_digest_items WHERE ref_id LIKE 'ce_demo_%';
