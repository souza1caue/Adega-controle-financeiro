import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const allowedKinds = new Set(['accounts', 'account_payments', 'sales']);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

// Keep original IDs so retrying an import never duplicates or overwrites records.
export function prepareHistoryRestore(payload) {
  if (!Array.isArray(payload.registros) || !payload.registros.length) throw new Error('No historical records supplied.');
  const seen = new Set();
  const accounts = new Set(payload.registros.filter((r) => r.kind === 'accounts').map((r) => r.id));
  return payload.registros.map((record) => {
    const { kind, id, data, created_at, updated_at } = record;
    if (!allowedKinds.has(kind) || typeof id !== 'string' || !id || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid historical record.');
    if (typeof created_at !== 'string' || typeof updated_at !== 'string') throw new Error('Missing original timestamps.');
    const key = `${kind}:${id}`;
    if (seen.has(key)) throw new Error('Duplicate historical record.');
    seen.add(key);
    if (kind === 'accounts') {
      if (!['customer', 'owner', 'tab'].includes(data.account_type)) throw new Error('Invalid account type.');
      if (data.account_type === 'tab' && data.status !== 'closed') throw new Error('Historical tabs must be closed.');
      for (const item of data.items || []) {
        if (item.source_tab_id && !accounts.has(item.source_tab_id)) throw new Error('Missing source tab.');
      }
    } else if (!accounts.has(data.account_id)) throw new Error('Missing related account.');
    return `INSERT INTO records (kind,id,data,created_at,updated_at) VALUES (${[kind, id, JSON.stringify(data), created_at, updated_at].map(quote).join(',')}) ON CONFLICT(kind,id) DO NOTHING;`;
  }).join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , input, output] = process.argv;
  if (!input || !output) throw new Error('Usage: node scripts/prepare-history-restore.mjs input.json output.sql');
  const payload = JSON.parse(readFileSync(input, 'utf8'));
  writeFileSync(output, prepareHistoryRestore(payload), { encoding: 'utf8', flag: 'wx' });
  console.log(`Prepared ${payload.registros.length} records. Existing IDs will be preserved.`);
}
