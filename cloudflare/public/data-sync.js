// Merge by revision so a delayed history request cannot resurrect deleted data
// or overwrite a newer sale/cancellation received by live synchronization.
export function mergeRecords(target, kind, records, versions, known) {
  target[kind] ||= {};
  for (const [id, value] of Object.entries(records || {})) {
    const key = `${kind}:${id}`, version = Number(versions?.[key] || 0);
    if (known.has(key) && known.get(key) > version) continue;
    target[kind][id] = value;
    known.set(key, version);
  }
}
export function mergeState(current, incoming, known) {
  if (!incoming.sync?.incremental) {
    known.clear();
    for (const [kind, records] of Object.entries(incoming)) {
      if (!records || typeof records !== 'object' || ['sync', 'stock_policy', 'front_identity'].includes(kind)) continue;
      for (const id of Object.keys(records)) known.set(`${kind}:${id}`, Number(incoming.sync?.cursor || 0));
    }
    return incoming;
  }
  for (const [kind, records] of Object.entries(incoming)) {
    if (['sync', 'stock_policy', 'front_identity'].includes(kind)) continue;
    mergeRecords(current, kind, records, incoming.sync.versions, known);
  }
  for (const { kind, id } of incoming.sync.deleted || []) {
    const key = `${kind}:${id}`, revision = incoming.sync.versions?.[key] || incoming.sync.cursor;
    if ((known.get(key) || 0) > revision) continue;
    delete current[kind]?.[id]; known.set(key, revision);
  }
  current.sync = incoming.sync;
  current.front_identity = incoming.front_identity;
  current.stock_policy = incoming.stock_policy;
  return current;
}
export function refreshDelay(module, page) {
  if (['Frente de caixa', 'Cozinha', 'Impressora'].includes(module) || ['kitchen', 'adminPrinter'].includes(page)) return 3000;
  return page === 'cash' ? 15000 : page === 'stock' ? 30000 : 60000;
}
