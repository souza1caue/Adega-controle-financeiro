// Run only against a disposable local Wrangler database (see SYNC.md).
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base = process.env.KITCHEN_TEST_URL || 'http://127.0.0.1:8788';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'This test must never create production orders');
const sockets = [];
async function api(path, headers = {}, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result)); return result;
}
const { token } = await api('/api/login', {}, { password: process.env.KITCHEN_TEST_PASSWORD || 'local-kitchen-test' });
const admin = { authorization: `Bearer ${token}` };
const mutate = (body, headers = admin) => api('/api/mutate', headers, body);
async function device(role) {
  const created = await mutate({ action: 'device.create', role, label: `Local ${role}` });
  const claimed = await api('/api/device/claim', {}, { code: created.code });
  return { 'x-device-access': claimed.access_token };
}
async function connect(headers) {
  const { ticket } = await api('/api/live-ticket', headers, {});
  const socket = new WebSocket(base.replace(/^http/, 'ws') + `/api/live?ticket=${encodeURIComponent(ticket)}`, { origin: base });
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return socket;
}
function signal(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', listener); reject(new Error('Live update timed out')); }, 5000);
    function listener(message) { if (message.toString() === 'changed') { clearTimeout(timeout); socket.off('message', listener); resolve(performance.now()); } }
    socket.on('message', listener);
  });
}
try {
  const state = await api('/api/state', admin);
  if (!Object.values(state.cash).some(c => c.status === 'open')) await mutate({ action: 'cash.open', opening_amount: 0 });
  const food = await mutate({ action: 'menu.save', name: 'Local test food', category: 'Comidas', price: 10, fixed_cost_price: 2 });
  const front = await device('front'), kitchen = await device('kitchen');
  let kitchenSocket = await connect(kitchen); const frontSocket = await connect(front);
  const before = await api('/api/state', front);
  const outgoing = signal(kitchenSocket), sentAt = performance.now();
  const payload = { action: 'sale.checkout', request_id: crypto.randomUUID(), customer_name: 'Local test', destination: 'sale', payment_method: 'Digital', items: [{ menu_id: food.id, quantity: 2, note: 'Local test only' }] };
  // Competing HTTP requests exercise the actual transaction and unique receipt.
  const [first, repeated] = await Promise.all([mutate(payload, front), mutate(payload, front)]);
  assert.equal(first.id, repeated.id);
  const arrival = await outgoing;
  const received = await api('/api/state', kitchen);
  assert.equal(received.kitchen[first.id].status, 'pending');
  assert.equal(received.kitchen[first.id].items[0].note, 'Local test only');
  const ackSignal = signal(frontSocket);
  await mutate({ action: 'kitchen.received', ids: [first.id] }, kitchen); await ackSignal;
  await mutate({ action: 'kitchen.status', id: first.id, status: 'started' }, kitchen);
  const readySignal = signal(frontSocket), readyAt = performance.now();
  await mutate({ action: 'kitchen.status', id: first.id, status: 'ready' }, kitchen);
  const readyArrival = await readySignal;
  const delta = await api(`/api/state?since=${before.sync.cursor}`, front);
  assert.equal(delta.kitchen[first.id].status, 'ready'); assert.ok(delta.kitchen[first.id].received_at);
  assert.equal(Object.values(delta.sales).filter(s => s.order_id === first.id).length, 1);
  kitchenSocket.close(); kitchenSocket = await connect(kitchen);
  assert.equal((await api('/api/state', kitchen)).kitchen[first.id].status, 'ready');
  const deliverySignal = signal(kitchenSocket);
  await mutate({ action: 'kitchen.status', id: first.id, status: 'delivered' }, front); await deliverySignal;
  assert.equal((await api('/api/state', kitchen)).kitchen[first.id].status, 'delivered');
  console.log(JSON.stringify({ result: 'passed', environment: 'local', sendToSignalMs: Math.round(arrival - sentAt), readyToSignalMs: Math.round(readyArrival - readyAt), checks: ['real WebSockets', 'simultaneous retry', 'receipt acknowledgement', 'ready notification', 'reconnect', 'delivery'] }));
} finally { for (const socket of sockets) socket.close(); }
