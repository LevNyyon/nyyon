-- Pipeline / deals board: reuse the clients table, add a stage + deal value.
-- stage is free text (lead | talking | discovery | offer-sent | reviewing | won | nurture | lost | active).
-- deal_value = one-time project $ (integer). mrr_value = monthly retainer $ (integer).
ALTER TABLE clients ADD COLUMN stage TEXT;
ALTER TABLE clients ADD COLUMN deal_value INTEGER;
ALTER TABLE clients ADD COLUMN mrr_value INTEGER;

-- Seed the current board from the live state.
UPDATE clients SET stage='active',     mrr_value=6500              WHERE id='cl-simply-funding';
UPDATE clients SET stage='active',     mrr_value=2000              WHERE id='cl-hms';
UPDATE clients SET stage='offer-sent', deal_value=4000, mrr_value=3000 WHERE id='cl-nitavalo';
UPDATE clients SET stage='nurture'                                 WHERE id='cl-conch';

INSERT OR IGNORE INTO clients (id, name, status, industry, engagement, owner, tags, notes, starred, created_at, updated_at, created_by, updated_by, stage)
VALUES ('cl-amit-giladi', 'Amit Giladi', 'prospect', NULL, 'In conversation — likely connector / referral source', 'Lev',
        '["prospect","warm","connector"]', 'linkedin.com/in/amitgiladi · +972 54-232-4568. Wants to connect Lev to others.',
        0, strftime('%s','now')*1000, strftime('%s','now')*1000, 'Lev', 'Lev', 'talking');
