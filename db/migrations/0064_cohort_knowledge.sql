-- The queue -> cohort rename moved the code to a new knowledge slug but left
-- the DOC behind under the old one, so every cadence setting the operator had
-- tuned silently fell back to the coded defaults: same numbers on screen, a
-- different set actually in force. Carry the doc across rather than reseeding,
-- so whatever was edited survives.
UPDATE knowledge_docs
   SET slug = 'outreach-cohort-cadence',
       title = 'Outreach · cohort cadence',
       updated_at = strftime('%s','now')*1000
 WHERE slug = 'outreach-queue-cadence'
   AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug = 'outreach-cohort-cadence');

-- Anything that pointed at the old slug as its parent follows it.
UPDATE knowledge_docs SET parent_slug = 'outreach-cohort-cadence'
 WHERE parent_slug = 'outreach-queue-cadence';

-- The seeded default cohort still described itself in the old vocabulary.
UPDATE outreach_cohorts
   SET note = 'The default cohort — everything added before named cohorts existed.'
 WHERE id = 'oq_default'
   AND note LIKE 'The default queue%';
