-- Pipeline / deals board: reuse the clients table, add a stage + deal value.
-- stage is free text (lead | talking | discovery | offer-sent | reviewing | won | nurture | lost | active).
-- deal_value = one-time project $ (integer). mrr_value = monthly retainer $ (integer).
ALTER TABLE clients ADD COLUMN stage TEXT;
ALTER TABLE clients ADD COLUMN deal_value INTEGER;
ALTER TABLE clients ADD COLUMN mrr_value INTEGER;

-- Seed data removed for the shipped product (the board starts empty; set stages from the Pipeline UI).
