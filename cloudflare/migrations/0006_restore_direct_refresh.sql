-- Direct snapshots no longer need the revision journal on every write.
-- Preserve all application records, balances and existing metadata.
DROP TRIGGER IF EXISTS records_sync_insert;
DROP TRIGGER IF EXISTS records_sync_update;
DROP TRIGGER IF EXISTS records_sync_delete;
DROP TRIGGER IF EXISTS balances_sync_insert;
DROP TRIGGER IF EXISTS balances_sync_update;
DROP TRIGGER IF EXISTS balances_sync_delete;
