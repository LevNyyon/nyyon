-- Unify CRM + pipeline: the pipeline IS the `clients` table (companies + stage).
-- This brings the CRM `contacts` (people) onto the pipeline board by inserting a
-- client/pipeline row per contact (person-as-account) with a mapped status+stage.
--
-- Idempotent: deterministic id `cl-c-<contactid>` + INSERT OR IGNORE, so re-runs
-- (and db:apply) never duplicate. Reversible: DELETE FROM clients WHERE id LIKE 'cl-c-%'.
-- Contact detail that has no column on `clients` (email/phone/title/company/
-- linkedin) is preserved in `notes`, and each row is tagged "person".

INSERT OR IGNORE INTO clients
  (id, name, status, industry, website, engagement, owner, tags, notes, starred,
   created_at, updated_at, created_by, updated_by, stage, deal_value, mrr_value)
SELECT
  'cl-c-' || id,
  COALESCE(NULLIF(TRIM(full_name), ''), email, phone, 'Unknown contact'),
  CASE status
    WHEN 'client'         THEN 'active'
    WHEN 'past_client'    THEN 'past'
    WHEN 'do_not_contact' THEN 'past'
    WHEN 'partner'        THEN 'partner'
    ELSE 'prospect'                              -- prospect | lead
  END,
  NULL,                                          -- industry (a person has none)
  linkedin_url,                                  -- website ← their LinkedIn
  NULL,                                          -- engagement
  owner,
  CASE
    WHEN tags IS NULL OR TRIM(tags) IN ('', '[]') THEN '["person"]'
    WHEN tags LIKE '%"person"%'                    THEN tags
    ELSE SUBSTR(TRIM(tags), 1, LENGTH(TRIM(tags)) - 1) || ',"person"]'
  END,
  TRIM(
    COALESCE(notes || CHAR(10) || CHAR(10), '') ||
    'Migrated from CRM contact.' ||
    COALESCE(' · ' || title,        '') ||
    COALESCE(' @ ' || company,      '') ||
    COALESCE(' · ' || email,        '') ||
    COALESCE(' · ' || phone,        '') ||
    COALESCE(' · ' || linkedin_url, '')
  ),
  COALESCE(starred, 0),
  COALESCE(created_at, strftime('%s','now') * 1000),
  strftime('%s','now') * 1000,
  COALESCE(created_by, 'crm-migration'),
  'crm-migration',
  CASE status
    WHEN 'client'         THEN 'active'
    WHEN 'partner'        THEN 'active'
    WHEN 'past_client'    THEN 'nurture'
    WHEN 'do_not_contact' THEN 'lost'
    WHEN 'lead'           THEN 'talking'
    ELSE 'lead'                                  -- prospect / anything else
  END,
  NULL,
  NULL
FROM contacts;
