-- Keep past tab transfers under the cash session where the tab was opened.
-- These entries settle the tab but are not money receipts.
UPDATE records
SET data=json_set(data,'$.cash_session_id',(
  SELECT json_extract(source.data,'$.cash_session_id') FROM records source
  WHERE source.kind='accounts' AND source.id=json_extract(records.data,'$.account_id')
)),updated_at=CURRENT_TIMESTAMP
WHERE kind='account_payments'
  AND (json_extract(data,'$.settlement_type')='transfer' OR json_extract(data,'$.payment_method')='Transferido para fiado')
  AND COALESCE(json_extract(data,'$.cash_session_id'),'')=''
  AND EXISTS(SELECT 1 FROM records source WHERE source.kind='accounts'
    AND source.id=json_extract(records.data,'$.account_id')
    AND COALESCE(json_extract(source.data,'$.cash_session_id'),'')<>'');
