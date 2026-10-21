-- An atomic receipt makes retries safe, including simultaneous submissions.
CREATE TABLE checkout_requests (
  request_key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  order_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
