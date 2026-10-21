import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixture, worker } from './fixture.mjs';
import { mergeState } from '../public/data-sync.js';

function device(f, role) {
  const token = `${role}-test`;
  f.put('device_access', role, { role, token_hash: createHash('sha256').update(token).digest('hex') });
  return { 'x-device-access': token };
}

function client(f, headers, kitchen = false) {
  const alerts = [], draws = [];
  const context = {
    data: {}, moduleEntryGeneration:0,
    syncVersions: new Map(), historyLoads: new Map(), historyPages: new Map(),
    syncUsage: { requests: 0, rows: 0 }, frontIdentityToken: '', originToken: '',
    deviceToken: headers['x-device-access'], token: '', page: kitchen ? 'kitchen' : 'sales',
    authIdentity: () => context.deviceToken, mergeState,
    document: { querySelector: () => null },localStorage:{removeItem(){}},
    entries: value => Object.entries(value || {}),
    kitchenViewOpen: () => kitchen, readyAlertsOpen: () => !kitchen,
    knownKitchenOrderIds: null, knownFrontKitchenStatuses: null,
    notifyKitchenOrder: id => alerts.push(id), notifyReadyOrder: id => alerts.push(id),
    draw: () => draws.push(true),
    fetch: (url, options) => worker.fetch(new Request(`http://localhost${url}`, options), f.env),
  };
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  runInNewContext(source.slice(source.indexOf('async function loadState('), source.indexOf('async function claimInvite(')), context);
  return { context, alerts, draws, load: () => context.loadState() };
}

for (const destination of ['sale', 'tab', 'account']) {
  test(`kitchen round trip with real API and frontend polling: ${destination}`, async () => {
    const f = fixture();
    try {
      f.put('menu', 'food', { name: 'Porcao', price: 20, category: 'Comidas', cost_mode: 'fixed', fixed_cost: 5 });
      const frontHeaders = device(f, 'front'), kitchenHeaders = device(f, 'kitchen');
      const front = client(f, frontHeaders), kitchen = client(f, kitchenHeaders, true);
      await front.load(); await kitchen.load();
      const order = await f.call({ action: 'sale.checkout', destination, customer_name: 'Cliente teste', payment_method: 'Digital',
        items: [{ menu_id: 'food', quantity: 2, note: 'Sem cebola' }, { menu_id: 'beer', quantity: 1 }] },
      destination === 'account' ? undefined : frontHeaders);
      assert.equal(order.status, 200, JSON.stringify(order));
      await kitchen.load(); await front.load();
      const received = kitchen.context.data.kitchen[order.id];
      assert.equal(received.status, 'pending');
      assert.equal(received.customer_name, 'Cliente teste');
      assert.equal(received.items.length, 1); // Drinks stay out of the kitchen queue.
      assert.equal(received.items[0].quantity, 2);
      assert.equal(received.items[0].note, 'Sem cebola');
      assert.deepEqual(kitchen.alerts, [order.id]);
      assert.equal(Object.keys(kitchen.context.data.sales).length, 0);
      await kitchen.load();
      assert.equal(kitchen.alerts.length, 1);
      for (const status of ['started', 'ready']) {
        const result = await f.call({ action: 'kitchen.status', id: order.id, status }, kitchenHeaders);
        assert.equal(result.status, 200, JSON.stringify(result));
        await front.load();
        assert.equal(front.context.data.kitchen[order.id].status, status);
        assert.ok(front.context.data.kitchen[order.id][`${status}_at`]);
      }
      assert.deepEqual(front.alerts, [order.id]);
      await front.load();
      assert.equal(front.alerts.length, 1); // Idle polling must not repeat ready alerts.
      assert.equal((await f.call({ action: 'kitchen.status', id: order.id, status: 'delivered' }, frontHeaders)).status, 200);
      await front.load(); await kitchen.load();
      assert.equal(front.context.data.kitchen[order.id].status, 'delivered');
      assert.equal(kitchen.context.data.kitchen[order.id].status, 'delivered');
      const reconnected = client(f, frontHeaders);
      await reconnected.load();
      assert.equal(reconnected.context.data.kitchen[order.id].status, 'delivered');
      assert.deepEqual(reconnected.alerts, []);
    } finally { f.sqlite.close(); }
  });
}

test('new kitchen device still receives old unfinished orders after reconnecting', async () => {
  const f = fixture();
  try {
    for (const status of ['pending', 'started', 'ready', 'delivered']) {
      f.put('kitchen', status, { status, created_at: '2020-01-01T00:00:00.000Z' });
    }
    const kitchen = client(f, device(f, 'kitchen'), true);
    await kitchen.load();
    assert.deepEqual(Object.keys(kitchen.context.data.kitchen).sort(), ['delivered', 'pending', 'ready', 'started']);
  } finally { f.sqlite.close(); }
});

test('a delayed response body cannot overwrite a module opened after that request started',async()=>{
  const f=fixture();
  try{
    const front=client(f,device(f,'front'));
    await front.load();const previous=front.context.data;
    let finish;
    front.context.fetch=async()=>({ok:true,json:()=>new Promise(resolve=>{finish=resolve})});
    const pending=front.load();await new Promise(resolve=>setImmediate(resolve));
    front.context.moduleEntryGeneration++;
    finish({kitchen:{stale:{status:'ready'}}});
    await pending;
    assert.equal(front.context.data.kitchen.stale,undefined);assert.equal(front.context.data,previous);
  }finally{f.sqlite.close()}
});
