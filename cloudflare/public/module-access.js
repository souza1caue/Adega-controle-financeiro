export function createOperationAccessCache({ request = fetch, storage = sessionStorage, now = Date.now } = {}) {
  const cached = new Map(), pending = new Map();
  function valid(value, role) {
    return value?.role === role && typeof value.access_token === 'string' && Number(value.expires_at) > now() + 60000;
  }
  async function get(role, force = false) {
    if (!['front', 'kitchen'].includes(role)) throw new Error('Área inválida.');
    const storageKey = `operationAccess:${role}`;
    if (!force) {
      let value = cached.get(role);
      if (!value) { try { value = JSON.parse(storage.getItem(storageKey)); } catch {} }
      if (valid(value, role)) { cached.set(role, value); return value; }
      if (pending.has(role)) return pending.get(role);
    }
    const task = (async () => {
      const response = await request('/api/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }), signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok || !valid(result, role)) throw new Error(result.error || 'Não foi possível acessar esta área.');
      cached.set(role, result);
      try { storage.setItem(storageKey, JSON.stringify(result)); } catch {}
      return result;
    })();
    pending.set(role, task);
    try { return await task; } finally { if (pending.get(role) === task) pending.delete(role); }
  }
  return { get, prefetch() { return Promise.allSettled(['front', 'kitchen'].map(role => get(role))); } };
}
