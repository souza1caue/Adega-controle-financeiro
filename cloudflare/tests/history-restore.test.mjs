import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareHistoryRestore } from '../scripts/prepare-history-restore.mjs';

const account = () => ({ kind: 'accounts', id: 'a', data: { account_type: 'customer', customer_name: "D'Ávila", items: [] }, created_at: '2026-08-13', updated_at: '2026-08-13' });
test('history restore escapes SQL values and preserves existing IDs on conflict', () => {
  const sql = prepareHistoryRestore({ registros: [account()] });
  assert.ok(sql.includes("D''Ávila"));
  assert.ok(sql.includes('ON CONFLICT(kind,id) DO NOTHING'));
});
test('history restore rejects unrelated data, dangling payments, duplicate IDs and open tabs', () => {
  assert.throws(() => prepareHistoryRestore({ registros: [{ ...account(), kind: 'sessions' }] }));
  assert.throws(() => prepareHistoryRestore({ registros: [{ ...account(), kind: 'account_payments', data: { account_id: 'missing' } }] }));
  assert.throws(() => prepareHistoryRestore({ registros: [account(), account()] }));
  assert.throws(() => prepareHistoryRestore({ registros: [{ ...account(), data: { account_type: 'tab', status: 'open' } }] }));
  assert.throws(() => prepareHistoryRestore({ registros: [{ ...account(), data: { account_type: 'customer', items: [{ source_tab_id: 'missing' }] } }] }));
});
