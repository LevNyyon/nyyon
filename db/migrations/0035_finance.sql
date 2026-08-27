-- 0035_finance.sql
-- Monthly cashflow calculator ("Agency Calculator"). One row per ledger line.
-- A month's running balance is computed in order: income rows add income_net,
-- expense and draw rows subtract expense. "Stays in account" = the month's
-- final balance (computed, not stored). income_net = income_pretax * 1.18 (VAT)
-- when a pre-VAT amount was entered; some incomes are entered net directly.
-- kind: 'income' | 'expense' | 'draw' (draw = the owner draw, money paid out to the owner).
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

-- Seed data removed for the shipped product (the ledger starts empty; add rows from the Finance UI).
