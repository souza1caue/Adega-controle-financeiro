// Each browser tab retains the same key after a lost response or a reload.
export function createCheckoutRetry(storage, uuid = () => crypto.randomUUID()) {
  let pending;
  try { pending = JSON.parse(storage.getItem('pendingCheckouts') || '{}'); } catch { pending = {}; }
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) pending = {};
  const save = () => storage.setItem('pendingCheckouts', JSON.stringify(pending));
  const signature = (scope, payload) => JSON.stringify([scope, payload]);
  return {
    begin(scope, payload) { const key = signature(scope, payload); if (!pending[key]) { pending[key] = uuid(); save(); } return { ...payload, request_id: pending[key] }; },
    complete(scope, payload) { delete pending[signature(scope, payload)]; save(); },
  };
}
