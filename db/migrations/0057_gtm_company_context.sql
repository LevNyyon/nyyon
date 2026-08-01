-- Company-level facts for a lead, so qualification judges the COMPANY and not
-- just the person's job title.
--
-- The ICP (the editable `brand-icp` knowledge doc) is mostly a statement about
-- companies: "founder-led, 50 employees or fewer, North America, technology-
-- dependent" for the primary profile, "200 to 500 employees, executive-sponsored
-- AI initiative" for the secondary. Yet scoreIcpFit only ever saw name, title,
-- company NAME, region and the org chart — never a headcount. So the single most
-- load-bearing criterion in the ICP was left to the model's guess about a brand
-- it may not know, and every verdict inherited that guess.
--
-- We already FETCH the number: getLiCompany (linkedin.js) returns
-- { company_id, name, universal_name, staff_count, url } and openRolesForLead
-- called it purely to get company_id, then dropped the rest on the floor. These
-- columns keep it.
--
--   company_staff_count  INTEGER  — LinkedIn headcount; the ICP's size bands
--   company_context      TEXT     — JSON snapshot of the resolve, the extensible
--                                   home for future company facts (industry, HQ)
--                                   without another migration:
--                                   { name, universal_name, url, staff_count, at }
--   company_checked_at   INTEGER  — ms epoch of the last resolve, so a bulk
--                                   re-run can skip leads checked recently
--                                   instead of re-paying the throttled call
--
-- NULL on every lead until the company-context action runs for it. Every reader
-- treats NULL as "not checked yet", never as "no employees".
ALTER TABLE gtm_leads ADD COLUMN company_staff_count INTEGER;
ALTER TABLE gtm_leads ADD COLUMN company_context TEXT;
ALTER TABLE gtm_leads ADD COLUMN company_checked_at INTEGER;
