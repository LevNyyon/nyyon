-- 0035_finance.sql
-- Monthly cashflow calculator ("Agency Calculator"). One row per ledger line.
-- A month's running balance is computed in order: income rows add income_net,
-- expense and draw rows subtract expense. "Stays in account" = the month's
-- final balance (computed, not stored). income_net = income_pretax * 1.18 (Ma'am)
-- when a pre-VAT amount was entered; some incomes are entered net directly.
-- kind: 'income' | 'expense' | 'draw' (draw = Payment to Lev, the owner draw).
CREATE TABLE IF NOT EXISTS finance_entries (
  id            TEXT PRIMARY KEY,
  year          INTEGER NOT NULL,
  month         INTEGER NOT NULL,            -- 1..12
  position      INTEGER NOT NULL,            -- order within the month
  kind          TEXT    NOT NULL DEFAULT 'expense',  -- income | expense | draw
  status        TEXT    NOT NULL DEFAULT '', -- '' | V | X | ! | ?
  item          TEXT    NOT NULL DEFAULT '',
  income_pretax REAL,                        -- pre-VAT income (nullable)
  income_net    REAL,                        -- amount added to balance (pretax*1.18 or entered directly)
  expense       REAL,                        -- amount subtracted (expense / draw)
  note          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finance_entries_ym ON finance_entries(year, month, position);

-- Seed: 2026 Jan..Jul, every line item, verified against the sheet's year totals.
INSERT OR IGNORE INTO finance_entries
  (id, year, month, position, kind, status, item, income_pretax, income_net, expense, note, created_at, updated_at)
VALUES
  ('fin-2026-01-01', 2026, 1, 1, 'income', '', 'AutonomyAI retainer', 45000, 53100, NULL, NULL, 0, 0),
  ('fin-2026-01-02', 2026, 1, 2, 'expense', '', 'Stenimitz May', NULL, NULL, 1175.98, NULL, 0, 0),
  ('fin-2026-01-03', 2026, 1, 3, 'expense', '', '5505 IL', NULL, NULL, 57.01, NULL, 0, 0),
  ('fin-2026-01-04', 2026, 1, 4, 'expense', '', '5505 US', NULL, NULL, 1237.4, NULL, 0, 0),
  ('fin-2026-01-05', 2026, 1, 5, 'expense', '', '5513 IL', NULL, NULL, 1022.75, NULL, 0, 0),
  ('fin-2026-01-06', 2026, 1, 6, 'expense', '', '5513 US', NULL, NULL, 504.37, NULL, 0, 0),
  ('fin-2026-01-07', 2026, 1, 7, 'expense', '', 'Commissions', NULL, NULL, 83.16, NULL, 0, 0),
  ('fin-2026-01-08', 2026, 1, 8, 'draw', '', 'Payment to Lev', NULL, NULL, 34313.53, NULL, 0, 0),
  ('fin-2026-02-01', 2026, 2, 1, 'income', '', 'AutonomyAI retainer', 45000, 53100, NULL, NULL, 0, 0),
  ('fin-2026-02-02', 2026, 2, 2, 'income', '', 'HMS Downpayment', 8550, 10089, NULL, NULL, 0, 0),
  ('fin-2026-02-03', 2026, 2, 3, 'expense', '', 'Stenimitz May', NULL, NULL, 1175.98, NULL, 0, 0),
  ('fin-2026-02-04', 2026, 2, 4, 'expense', '', '5505 IL', NULL, NULL, 57.01, NULL, 0, 0),
  ('fin-2026-02-05', 2026, 2, 5, 'expense', '', '5505 US', NULL, NULL, 1237.4, NULL, 0, 0),
  ('fin-2026-02-06', 2026, 2, 6, 'expense', '', '5513 IL', NULL, NULL, 1022.75, NULL, 0, 0),
  ('fin-2026-02-07', 2026, 2, 7, 'expense', '', '5513 US', NULL, NULL, 83.16, NULL, 0, 0),
  ('fin-2026-02-08', 2026, 2, 8, 'expense', '', 'Commissions', NULL, NULL, 229.35, NULL, 0, 0),
  ('fin-2026-02-09', 2026, 2, 9, 'draw', '', 'Payment to Lev', NULL, NULL, 41568.35, NULL, 0, 0),
  ('fin-2026-03-01', 2026, 3, 1, 'income', '', 'AutonomyAI retainer', 45000, 53100, NULL, NULL, 0, 0),
  ('fin-2026-03-02', 2026, 3, 2, 'income', '', 'Simply Downpayment', NULL, 10262.88, NULL, 'from US no tax?', 0, 0),
  ('fin-2026-03-03', 2026, 3, 3, 'expense', '', 'Stenimitz May', NULL, NULL, 1172.58, NULL, 0, 0),
  ('fin-2026-03-04', 2026, 3, 4, 'expense', '', '5505 IL', NULL, NULL, 6842.01, '?? CC doesnt have that expense', 0, 0),
  ('fin-2026-03-05', 2026, 3, 5, 'expense', '', '5505 US', NULL, NULL, 1355.06, NULL, 0, 0),
  ('fin-2026-03-06', 2026, 3, 6, 'expense', '', '5513 IL', NULL, NULL, 1022.75, NULL, 0, 0),
  ('fin-2026-03-07', 2026, 3, 7, 'expense', '', '5513 US', NULL, NULL, 604.17, NULL, 0, 0),
  ('fin-2026-03-08', 2026, 3, 8, 'expense', '', 'Commissions', NULL, NULL, 200.6, NULL, 0, 0),
  ('fin-2026-03-09', 2026, 3, 9, 'draw', '', 'Payment to Lev', NULL, NULL, 36516, NULL, 0, 0),
  ('fin-2026-04-01', 2026, 4, 1, 'income', 'V', 'Simply Funding - CRM + Full Month + Bonus', NULL, 22858.5, NULL, '7785 USD, 2.94 exchange rate, No Maam', 0, 0),
  ('fin-2026-04-02', 2026, 4, 2, 'income', 'V', 'HMS', 15750, 18585, NULL, NULL, 0, 0),
  ('fin-2026-04-03', 2026, 4, 3, 'expense', 'V', 'Expenses', NULL, NULL, 12454.02, NULL, 0, 0),
  ('fin-2026-04-04', 2026, 4, 4, 'draw', '', 'Payment to Lev', NULL, NULL, 20292.64, NULL, 0, 0),
  ('fin-2026-05-01', 2026, 5, 1, 'income', 'X', 'Simply', NULL, 0, NULL, NULL, 0, 0),
  ('fin-2026-05-02', 2026, 5, 2, 'income', 'X', 'HMS', NULL, 0, NULL, NULL, 0, 0),
  ('fin-2026-05-03', 2026, 5, 3, 'expense', 'V', 'rashut ha misim', NULL, NULL, 10701, NULL, 0, 0),
  ('fin-2026-05-04', 2026, 5, 4, 'expense', 'V', 'Michal', NULL, NULL, 6600, NULL, 0, 0),
  ('fin-2026-05-05', 2026, 5, 5, 'expense', 'V', 'Stefan #1', NULL, NULL, 4350, NULL, 0, 0),
  ('fin-2026-05-06', 2026, 5, 6, 'expense', 'V', 'Stenimitz May', NULL, NULL, 1179.39, NULL, 0, 0),
  ('fin-2026-05-07', 2026, 5, 7, 'expense', 'V', '5505 IL', NULL, NULL, 57.01, NULL, 0, 0),
  ('fin-2026-05-08', 2026, 5, 8, 'expense', 'V', '5505 US', NULL, NULL, 742.6, NULL, 0, 0),
  ('fin-2026-05-09', 2026, 5, 9, 'expense', 'V', '5513 IL', NULL, NULL, 1022.75, NULL, 0, 0),
  ('fin-2026-05-10', 2026, 5, 10, 'expense', 'V', '5513 US', NULL, NULL, 387.78, NULL, 0, 0),
  ('fin-2026-05-11', 2026, 5, 11, 'expense', 'V', 'Commissions', NULL, NULL, 104.28, NULL, 0, 0),
  ('fin-2026-05-12', 2026, 5, 12, 'draw', '', 'Payment to Lev', NULL, NULL, -17601.37, 'negative draw: money returned to the account', 0, 0),
  ('fin-2026-06-01', 2026, 6, 1, 'income', 'V', 'Simply #1', NULL, 18850, NULL, NULL, 0, 0),
  ('fin-2026-06-02', 2026, 6, 2, 'income', 'V', 'Simply #2', NULL, 18850, NULL, NULL, 0, 0),
  ('fin-2026-06-03', 2026, 6, 3, 'expense', '', 'Stenimitz', NULL, NULL, 1193.01, NULL, 0, 0),
  ('fin-2026-06-04', 2026, 6, 4, 'expense', '', '5505 IL', NULL, NULL, 57.01, NULL, 0, 0),
  ('fin-2026-06-05', 2026, 6, 5, 'expense', '', '5505 US', NULL, NULL, 732.6, NULL, 0, 0),
  ('fin-2026-06-06', 2026, 6, 6, 'expense', '', '5513 IL', NULL, NULL, 1022.75, NULL, 0, 0),
  ('fin-2026-06-07', 2026, 6, 7, 'expense', '', '5513 US', NULL, NULL, 387.78, NULL, 0, 0),
  ('fin-2026-06-08', 2026, 6, 8, 'expense', '', 'Commissions', NULL, NULL, 519.98, NULL, 0, 0),
  ('fin-2026-06-09', 2026, 6, 9, 'expense', 'V', 'Stefan #2', NULL, NULL, 4350, NULL, 0, 0),
  ('fin-2026-06-10', 2026, 6, 10, 'expense', 'V', 'Stefan #3', NULL, NULL, 2175, NULL, 0, 0),
  ('fin-2026-06-11', 2026, 6, 11, 'draw', '', 'Payment to Lev', NULL, NULL, 19083.31, NULL, 0, 0),
  ('fin-2026-07-01', 2026, 7, 1, 'income', '!', 'Simply', NULL, 18850, NULL, NULL, 0, 0),
  ('fin-2026-07-02', 2026, 7, 2, 'income', '?', 'HMS', 6000, 7080, NULL, NULL, 0, 0),
  ('fin-2026-07-03', 2026, 7, 3, 'income', '?', 'Pelgey Maim', 9000, 10620, NULL, NULL, 0, 0),
  ('fin-2026-07-04', 2026, 7, 4, 'expense', '', 'Stenimitz', NULL, NULL, 1179.39, NULL, 0, 0),
  ('fin-2026-07-05', 2026, 7, 5, 'expense', '', '5505 IL', NULL, NULL, 57.01, NULL, 0, 0),
  ('fin-2026-07-06', 2026, 7, 6, 'expense', '', '5505 US', NULL, NULL, 732.6, NULL, 0, 0),
  ('fin-2026-07-07', 2026, 7, 7, 'expense', '', '5513 IL', NULL, NULL, 1022.75, NULL, 0, 0),
  ('fin-2026-07-08', 2026, 7, 8, 'expense', '', '5513 US', NULL, NULL, 387.78, NULL, 0, 0),
  ('fin-2026-07-09', 2026, 7, 9, 'expense', '', 'Commissions', NULL, NULL, 104.28, NULL, 0, 0),
  ('fin-2026-07-10', 2026, 7, 10, 'expense', '', 'Maam', NULL, NULL, 4500, NULL, 0, 0),
  ('fin-2026-07-11', 2026, 7, 11, 'expense', '', 'Michal', NULL, NULL, 3500, NULL, 0, 0),
  ('fin-2026-07-12', 2026, 7, 12, 'expense', '', 'Stefan', NULL, NULL, 4500, NULL, 0, 0),
  ('fin-2026-07-13', 2026, 7, 13, 'draw', '', 'Payment to Lev', NULL, NULL, 14396.33, NULL, 0, 0);

-- Stamp seed timestamps once (kept 0 above for a deterministic, re-runnable seed).
UPDATE finance_entries SET created_at = strftime('%s','now')*1000, updated_at = strftime('%s','now')*1000 WHERE created_at = 0;
