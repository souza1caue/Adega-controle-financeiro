const OPERATION_KINDS = new Set(['sales', 'account_payments', 'staff_shifts', 'hosted_events', 'stock_events', 'inventories']);
const HISTORY_KINDS = new Set([...OPERATION_KINDS, 'stock_movements', 'kitchen', 'accounts']);
const eventDate = "COALESCE(json_extract(data,'$.created_at'),'')";

export const publicKinds = ['settings', 'menu', 'accounts', 'account_payments', 'sales', 'kitchen', 'cash', 'stock_movements', 'stock_items', 'recipes', 'inventories', 'employees', 'staff_shifts', 'device_access', 'stock_events', 'hosted_events'];
export function allowedKinds(admin, kitchen) {
  return admin ? publicKinds : kitchen ? ['kitchen'] : publicKinds.filter(kind => !['inventories', 'employees', 'staff_shifts', 'device_access'].includes(kind));
}
function safeRecord(kind, value) {
  if (kind === 'device_access') { delete value.token_hash; delete value.claim_code_hash; }
  return value;
}
async function hydrateBalances(db, result) {
  const ids = Object.keys(result.stock_items || {});
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const rows = await db.prepare(`SELECT id,quantity,updated_at FROM stock_balances WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const row of rows.results) Object.assign(result.stock_items[row.id], { stock_quantity: Number(row.quantity), stock_updated_at: row.updated_at });
  }
}

function observeReads(source) {
  const usage = { data_rows_read: 0, available: false };
  const db = { prepare(sql) {
    let statement = source.prepare(sql);
    const wrapped = {
      bind(...args) { statement = statement.bind(...args); return wrapped; },
      async all() {
        const result = await statement.all();
        if (result.meta?.rows_read != null) { usage.available = true; usage.data_rows_read += Number(result.meta.rows_read); }
        return result;
      },
      async first() { return (await wrapped.all()).results[0] || null; }
    };
    return wrapped;
  } };
  return { db, usage };
}

export async function syncState(source, params, kinds) {
  const { db, usage } = observeReads(source);
  // Capture the cursor BEFORE reading records: concurrent writes are replayed
  // next time, never skipped. Replaying an already seen value is harmless.
  const clock = await db.prepare('SELECT COALESCE(MAX(seq),0) AS cursor FROM record_changes').first();
  const upper = Number(clock.cursor);
  const raw = params.get('since');
  const since = raw === null ? null : Number(raw);
  const incremental = Number.isSafeInteger(since) && since >= 0 && since <= upper;
  const result = Object.fromEntries(publicKinds.map(kind => [kind, {}]));
  const deleted = [], versions = {};
  let cursor = upper, more = false;
  if (incremental) {
    // Read the journal in sequence order, including private changes so the
    // cursor also advances when only access credentials were modified.
    const changes = await db.prepare(`SELECT c.seq,c.kind,c.record_id,c.deleted,r.data FROM record_changes c
      LEFT JOIN records r ON r.kind=c.kind AND r.id=c.record_id
      WHERE c.seq>? AND c.seq<=? ORDER BY c.seq LIMIT 501`).bind(since, upper).all();
    more = changes.results.length > 500;
    const batch = changes.results.slice(0, 500);
    if (more) cursor = Number(batch.at(-1).seq);
    for (const row of batch) {
      if (!kinds.includes(row.kind)) continue;
      versions[`${row.kind}:${row.record_id}`] = Number(row.seq);
      if (row.deleted || !row.data) deleted.push({ kind: row.kind, id: row.record_id });
      else result[row.kind][row.record_id] = safeRecord(row.kind, JSON.parse(row.data));
    }
  } else {
    const opened = await db.prepare("SELECT id,data FROM records WHERE kind='cash' AND COALESCE(json_extract(data,'$.status'),'')='open'").all();
    const cashIds = opened.results.map(row => row.id);
    const started = opened.results.map(row => JSON.parse(row.data).opened_at).filter(Boolean).sort()[0] || new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
    for (const kind of kinds) {
      let sql = 'SELECT id,data FROM records WHERE kind=?', args = [kind];
      if (OPERATION_KINDS.has(kind)) {
        if (!cashIds.length) continue;
        sql += ` AND json_extract(data,'$.cash_session_id') IN (${cashIds.map(() => '?').join(',')})`;
        args.push(...cashIds);
      } else if (kind === 'stock_movements') {
        sql += ` AND ${eventDate}>=?`; args.push(started);
      } else if (kind === 'kitchen') {
        // Keep pending work regardless of age and today's deliveries. Kitchen
        // history older than this is loaded explicitly, never at every poll.
        sql += ` AND (COALESCE(json_extract(data,'$.status'),'') NOT IN ('done','delivered','cancelled') OR ${eventDate}>=?)`;
        args.push(started);
      }
      const rows = await db.prepare(sql).bind(...args).all();
      for (const row of rows.results) result[kind][row.id] = safeRecord(kind, JSON.parse(row.data));
    }
  }
  await hydrateBalances(db, result);
  return { ...result, stock_policy: { allow_sales_without_stock: true }, sync: { cursor, incremental, deleted, more, versions, usage } };
}

export async function historyPage(db, params, kinds) {
  const kind = params.get('kind');
  if (!HISTORY_KINDS.has(kind) || !kinds.includes(kind)) throw new Error('Consulta de historico nao permitida.');
  const limit = Math.min(200, Math.max(1, Number(params.get('limit')) || 100));
  const before = params.get('before');
  let position = null;
  if (before) {
    try { position = JSON.parse(before); } catch { throw new Error('Pagina de historico invalida.'); }
    if (!Array.isArray(position) || position.length !== 2 || position.some(value => typeof value !== 'string')) throw new Error('Pagina de historico invalida.');
  }
  const clauses = ['kind=?'], args = [kind];
  if (params.has('account_id')) { clauses.push("json_extract(data,'$.account_id')=?"); args.push(params.get('account_id')); }
  if (params.has('cash_id')) { clauses.push("json_extract(data,'$.cash_session_id')=?"); args.push(params.get('cash_id')); }
  let prefix = '', table = 'records';
  if (!params.has('cash_id') && (params.has('from') || params.has('to'))) {
    const from = params.get('from'), to = params.get('to');
    if (!from || !to || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || from > to) throw new Error('Periodo invalido.');
    // Materialize only the selected cash sessions and legacy date range. This
    // prevents ORDER BY from scanning every historical sale to find a period.
    prefix = `WITH selected_records AS MATERIALIZED (
      SELECT kind,id,data FROM records INDEXED BY idx_records_cash_session WHERE kind=? AND json_extract(data,'$.cash_session_id') IN
        (SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.opened_at')>=? AND json_extract(data,'$.opened_at')<=?)
      UNION ALL
      SELECT kind,id,data FROM records INDEXED BY idx_records_event_date WHERE kind=? AND ${eventDate}>=? AND ${eventDate}<=?
        AND (json_extract(data,'$.cash_session_id') IS NULL OR json_extract(data,'$.cash_session_id')='')
    ) `;
    table = 'selected_records';
    args.unshift(kind, from, to, kind, from, to);
  }
  if (position) { clauses.push(`(${eventDate},id)<(?,?)`); args.push(...position); }
  const index = prefix ? '' : params.has('account_id') ? ' INDEXED BY idx_records_account' : params.has('cash_id') ? ' INDEXED BY idx_records_cash_session' : '';
  const rows = await db.prepare(`${prefix}SELECT id,data,${eventDate} AS event_date,COALESCE((SELECT seq FROM record_changes WHERE record_changes.kind=${table}.kind AND record_id=${table}.id),0) AS revision FROM ${table}${index} WHERE ${clauses.join(' AND ')} ORDER BY ${eventDate} DESC,id DESC LIMIT ?`).bind(...args, limit + 1).all();
  const page = rows.results.slice(0, limit), more = rows.results.length > limit;
  return { kind, versions: Object.fromEntries(page.map(row => [`${kind}:${row.id}`, Number(row.revision)])), records: Object.fromEntries(page.map(row => [row.id, safeRecord(kind, JSON.parse(row.data))])), next: more ? JSON.stringify([page.at(-1).event_date, page.at(-1).id]) : null };
}
