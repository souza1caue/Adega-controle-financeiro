-- Preserve balances and audit history while allowing sales pending stock entry.
CREATE TABLE stock_balances_next (
  id TEXT PRIMARY KEY,
  quantity REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO stock_balances_next(id, quantity, updated_at)
SELECT id, quantity, updated_at FROM stock_balances;
DROP TABLE stock_balances;
ALTER TABLE stock_balances_next RENAME TO stock_balances;
