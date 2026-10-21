import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { liveTicket, verifyLiveTicket, OrderLive } from '../src/live-orders.js';
import { fixture, worker } from './fixture.mjs';

const sale = extra => ({ action: 'sale.checkout', request_id: 'retry-safe-order-0001', destination: 'sale', payment_method: 'Digital', items: [{ menu_id: 'beer', quantity: 2 }], ...extra });
const device = (f, role) => {
  f.put('device_access', role, { role, token_hash: createHash('sha256').update(role).digest('hex') });
  return { 'x-device-access': role };
};

test('checkout retries return the original receipt without duplicate sales or stock deductions', async () => {
  const f = fixture();
  try {
    const first = await f.call(sale());
    assert.equal(first.status, 200);
    const repeated = await f.call(sale());
    assert.equal(repeated.id, first.id); assert.equal(repeated.already_recorded, true);
    assert.equal(f.records('sales').length, 1); assert.equal(f.balance('beer'), -2);
    assert.equal((await f.call(sale({ customer_name: 'Different' }))).status, 409);
    assert.equal(f.records('sales').length, 1);
    assert.equal((await f.call(sale({ request_id: 'another-order-0002' }))).status, 200);
    assert.equal(f.records('sales').length, 2);
    // Receipts are scoped to the authenticated device, and cannot bypass revocation.
    const front = device(f, 'front');
    assert.equal((await f.call(sale(), front)).status, 200);
    f.put('device_access', 'front', { role: 'front', revoked_at: 'now', token_hash: createHash('sha256').update('front').digest('hex') });
    assert.equal((await f.call(sale(), front)).status, 401);
  } finally { f.sqlite.close(); }
});

test('failed transactions also roll back their retry receipt', async () => {
  const f = fixture();
  try {
    f.put('recipes', 'beer', { components: [{ stock_item_id: 'missing', quantity: 1 }] });
    assert.equal((await f.call(sale())).status, 400);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM checkout_requests').get().n, 0);
    f.put('recipes', 'beer', { components: [{ stock_item_id: 'beer', quantity: 1 }] });
    assert.equal((await f.call(sale())).status, 200);
    assert.equal(f.balance('beer'), -2);
  } finally { f.sqlite.close(); }
});

test('receipt confirmation requires kitchen access, is stable on retry, and does not overwrite preparation', async () => {
  const f = fixture();
  try {
    const kitchen = device(f, 'kitchen'), front = device(f, 'front');
    f.put('kitchen', 'order', { status: 'pending', created_at: new Date().toISOString() });
    const payload = { action: 'kitchen.received', ids: ['order'] };
    assert.equal((await f.call(payload, front)).status, 403);
    assert.equal((await f.call(payload, kitchen)).status, 200);
    const received = f.records('kitchen')[0].received_at; assert.ok(received);
    assert.equal((await f.call({ action: 'kitchen.status', id: 'order', status: 'started' }, kitchen)).status, 200);
    assert.equal((await f.call(payload, kitchen)).status, 200);
    assert.equal(f.records('kitchen')[0].received_at, received);
    assert.equal(f.records('kitchen')[0].status, 'started');
    assert.equal((await f.call({ action: 'kitchen.status', id: 'order', status: 'ready' }, kitchen)).status, 200);
    assert.equal((await f.call({ action: 'kitchen.status', id: 'order', status: 'started' }, kitchen)).status, 409);
    assert.equal((await f.call({ action: 'kitchen.status', id: 'order', status: 'delivered' }, front)).status, 200);
    assert.equal((await f.call({ action: 'kitchen.status', id: 'order', status: 'ready' }, kitchen)).status, 409);
  } finally { f.sqlite.close(); }
});

test('live tickets require authorization and signed short expiry; foreign origins are rejected', async () => {
  const ticket = await liveTicket('secret', 100000);
  assert.equal(await verifyLiveTicket('secret', ticket, 100001), true);
  assert.equal(await verifyLiveTicket('other', ticket, 100001), false);
  assert.equal(await verifyLiveTicket('secret', ticket, 160001), false);
  assert.equal(await verifyLiveTicket('secret', ticket + 'x', 100001), false);
  const f = fixture();
  try {
    let forwarded = 0;
    f.env.ORDER_LIVE = { idFromName: name => name, get: () => ({ fetch: async () => { forwarded++; return new Response('connected'); } }) };
    const endpoint = headers => worker.fetch(new Request('http://localhost/api/live-ticket', { method: 'POST', headers }), f.env);
    assert.equal((await endpoint({})).status, 401);
    const response = await endpoint({ authorization: 'Bearer test-token' }); assert.equal(response.status, 200);
    const { ticket } = await response.json();
    assert.equal((await worker.fetch(new Request(`http://localhost/api/live?ticket=${ticket}`, { headers: { Origin: 'https://foreign.test' } }), f.env)).status, 403);
    assert.equal((await worker.fetch(new Request('http://localhost/api/live?ticket=invalid', { headers: { Origin: 'http://localhost' } }), f.env)).status, 401);
    assert.equal(forwarded, 0);
    assert.equal((await worker.fetch(new Request(`http://localhost/api/live?ticket=${ticket}`, { headers: { Origin: 'http://localhost' } }), f.env)).status, 200);
    assert.equal(forwarded, 1);
  } finally { f.sqlite.close(); }
});

test('live hub sends no business data, expires old connections, and tolerates broken sockets', async () => {
  const messages = [], closed = [];
  const socket = (expires, broken = false) => ({ deserializeAttachment: () => ({ expires }), send(value) { if (broken) throw new Error('gone'); messages.push(value); }, close: code => closed.push(code) });
  const hub = new OrderLive({ getWebSockets: () => [socket(Date.now() + 10000), socket(0), socket(Date.now() + 10000, true)] });
  assert.equal((await hub.fetch(new Request('https://internal/publish', { method: 'POST' }))).status, 204);
  assert.deepEqual(messages, ['changed']); assert.deepEqual(closed, [1000, 1011]);
});

test('notification failure cannot turn a committed order into an apparent checkout failure', async () => {
  const f = fixture();
  try {
    f.env.ORDER_LIVE = { idFromName: name => name, get: () => ({ fetch: async () => { throw new Error('offline'); } }) };
    const result = await f.call(sale()); assert.equal(result.status, 200);
    assert.equal(f.records('sales').length, 1);
    assert.equal((await f.call(sale())).id, result.id);
  } finally { f.sqlite.close(); }
});

test('activation codes work with journal triggers and cannot be claimed twice', async () => {
  const f = fixture();
  const claim = async (path, body) => {
    const response = await worker.fetch(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), f.env);
    return { status: response.status, ...await response.json() };
  };
  try {
    const created = await f.call({ action: 'device.create', role: 'kitchen', label: 'Kitchen' });
    const activated = await claim('/api/device/claim', { code: created.code });
    assert.equal(activated.status, 200); assert.ok(activated.access_token);
    assert.equal((await claim('/api/device/claim', { code: created.code })).status, 401);
    f.put('staff_access', 'single', { employee_name: 'Test', cash_session_id: 'cash', expires_at: '2099-01-01', token_hash: createHash('sha256').update('single-use').digest('hex') });
    const staff = await claim('/api/staff/claim', { invite_token: 'single-use' });
    assert.equal(staff.status, 200); assert.ok(staff.access_token);
    assert.equal((await claim('/api/staff/claim', { invite_token: 'single-use' })).status, 401);
  } finally { f.sqlite.close(); }
});

test('preparation preserves a concurrent receipt, and printing preserves the current stage', async () => {
  const f = fixture();
  try {
    f.put('kitchen', 'order', { status: 'pending', print_status: 'pending', print_count: 0 });
    const prepare = f.env.DB.prepare;
    f.env.DB.prepare = sql => {
      if (sql.startsWith('UPDATE records SET data=json_patch')) {
        f.sqlite.prepare("UPDATE records SET data=json_set(data,'$.received_at','concurrent-receipt') WHERE kind='kitchen' AND id='order'").run();
      }
      if (sql.startsWith("UPDATE records SET data=json_set(data,'$.print_status','printed'")) {
        f.sqlite.prepare("UPDATE records SET data=json_set(data,'$.status','ready') WHERE kind='kitchen' AND id='order'").run();
      }
      return prepare(sql);
    };
    assert.equal((await f.call({ action: 'kitchen.status', id: 'order', status: 'started' })).status, 200);
    assert.equal(f.records('kitchen')[0].received_at, 'concurrent-receipt');
    assert.equal((await f.call({ action: 'kitchen.printed', id: 'order' })).status, 200);
    assert.equal(f.records('kitchen')[0].status, 'ready');
    assert.equal(f.records('kitchen')[0].print_count, 1);
  } finally { f.sqlite.close(); }
});
