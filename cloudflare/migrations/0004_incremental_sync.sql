-- One revision per record, including tombstones. The journal stays bounded by
-- the number of distinct records instead of growing with every polling request.
CREATE TABLE record_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind, record_id)
);

CREATE TRIGGER records_sync_insert AFTER INSERT ON records BEGIN
  DELETE FROM record_changes WHERE kind=NEW.kind AND record_id=NEW.id;
  INSERT INTO record_changes(kind,record_id,deleted) VALUES(NEW.kind,NEW.id,0);
END;
CREATE TRIGGER records_sync_update AFTER UPDATE ON records BEGIN
  DELETE FROM record_changes WHERE kind=NEW.kind AND record_id=NEW.id;
  INSERT INTO record_changes(kind,record_id,deleted) VALUES(NEW.kind,NEW.id,0);
END;
CREATE TRIGGER records_sync_delete AFTER DELETE ON records BEGIN
  DELETE FROM record_changes WHERE kind=OLD.kind AND record_id=OLD.id;
  INSERT INTO record_changes(kind,record_id,deleted) VALUES(OLD.kind,OLD.id,1);
END;
CREATE TRIGGER balances_sync_insert AFTER INSERT ON stock_balances BEGIN
  DELETE FROM record_changes WHERE kind='stock_items' AND record_id=NEW.id;
  INSERT INTO record_changes(kind,record_id,deleted) VALUES('stock_items',NEW.id,0);
END;
CREATE TRIGGER balances_sync_update AFTER UPDATE ON stock_balances BEGIN
  DELETE FROM record_changes WHERE kind='stock_items' AND record_id=NEW.id;
  INSERT INTO record_changes(kind,record_id,deleted) VALUES('stock_items',NEW.id,0);
END;
CREATE TRIGGER balances_sync_delete AFTER DELETE ON stock_balances BEGIN
  DELETE FROM record_changes WHERE kind='stock_items' AND record_id=OLD.id;
  INSERT INTO record_changes(kind,record_id,deleted) VALUES('stock_items',OLD.id,0);
END;

CREATE INDEX idx_records_cash_session ON records(kind,json_extract(data,'$.cash_session_id'),id);
CREATE INDEX idx_records_event_date ON records(kind,COALESCE(json_extract(data,'$.created_at'),''),id);
CREATE INDEX idx_records_account ON records(kind,json_extract(data,'$.account_id'),id);
CREATE INDEX idx_records_cash_opened ON records(json_extract(data,'$.opened_at'),id) WHERE kind='cash';
CREATE INDEX idx_records_device_token ON records(json_extract(data,'$.token_hash')) WHERE kind='device_access';
CREATE INDEX idx_records_staff_token ON records(json_extract(data,'$.token_hash')) WHERE kind='staff_access';
