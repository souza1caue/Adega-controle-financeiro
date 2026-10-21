// Signals trigger authorized incremental reads; a periodic read repairs missed signals.
export function createLiveSync({ headers, identity, active, refresh, status, url = location.origin,
  request = fetch, Socket = WebSocket, later = setTimeout, cancel = clearTimeout, now = Date.now, random = Math.random }) {
  let socket = null, connecting = false, generation = 0, owner = '', retry = null, renew = null, debounce = null, timeout = null, failures = 0;
  let connected = false, lastSync = 0;
  const report = () => status(connected);
  function stop() {
    generation++; connecting = false; connected = false;
    for (const timer of [retry, renew, debounce, timeout]) if (timer !== null) cancel(timer);
    retry = renew = debounce = timeout = null;
    const previous = socket; socket = null;
    if (previous) { previous.onclose = null; previous.close(); }
    report();
  }
  function changed() {
    if (!active() || debounce !== null) return;
    debounce = later(() => { debounce = null; if (active()) Promise.resolve(refresh()).catch(() => {}); }, 80);
  }
  function reconnect() {
    connected = false; connecting = false; report();
    if (!active() || retry !== null) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)) + random() * 500;
    retry = later(() => { retry = null; ensure(); }, delay);
  }
  async function ensure() {
    if (!active()) { stop(); return; }
    const nextOwner = identity();
    if (owner !== nextOwner) { stop(); owner = nextOwner; failures = 0; }
    if (socket || connecting || retry !== null) return;
    connecting = true;
    const current = generation;
    try {
      const response = await request('/api/live-ticket', { method: 'POST', headers: headers(), signal: AbortSignal.timeout(10000) });
      if (generation !== current || !active() || identity() !== nextOwner) return;
      if (!response.ok) throw new Error('Live channel unavailable');
      const { ticket } = await response.json();
      if (generation !== current || !active() || identity() !== nextOwner) return;
      const target = new URL('/api/live', url); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      target.searchParams.set('ticket', ticket);
      const connection = new Socket(target.href); socket = connection;
      timeout = later(() => { if (socket === connection && !connected) connection.close(); }, 10000);
      connection.onopen = () => {
        if (generation !== current || !active()) { connection.close(); return; }
        cancel(timeout); timeout = null; connecting = false; connected = true; failures = 0; report();
        changed(); // Reconcile changes made between the last read and connection establishment.
        renew = later(() => { stop(); ensure(); }, 240000);
      };
      connection.onmessage = event => { if (event.data === 'changed') changed(); };
      connection.onerror = () => connection.close();
      connection.onclose = () => {
        if (socket !== connection) return;
        socket = null; cancel(timeout); cancel(renew); timeout = renew = null;
        reconnect();
      };
    } catch { if (generation === current) reconnect(); }
    finally { if (generation === current && !socket) connecting = false; }
  }
  return { ensure, stop, synced() { lastSync = now(); },
    shouldPoll() { return !connected || now() - lastSync >= 60000; },
    get connected() { return connected; } };
}

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
