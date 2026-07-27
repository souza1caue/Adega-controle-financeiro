CREATE TABLE IF NOT EXISTS stock_balances (
  id TEXT PRIMARY KEY,
  quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO stock_balances(id, quantity)
SELECT id, MAX(0, COALESCE(json_extract(data, '$.stock_quantity'), 0))
FROM records
WHERE kind = 'stock_items';
