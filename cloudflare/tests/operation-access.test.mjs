import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixture, worker } from './fixture.mjs';
import { operationAccess, verifyOperationAccess } from '../src/operation-access.js';
import { createOperationAccessCache } from '../public/module-access.js';

async function access(f, role) {
  const response = await worker.fetch(new Request('http://localhost/api/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) }), f.env);
  return { status: response.status, ...await response.json() };
}
async function state(f, headers) {
  const response = await worker.fetch(new Request('http://localhost/api/state', { headers }), f.env);
  return { status: response.status, ...await response.json() };
}

test('Caixa and Cozinha open without password or registered device, while Admin remains protected', async () => {
  const f = fixture();
  try {
    const front = await access(f, 'front'), kitchen = await access(f, 'kitchen');
    assert.equal(front.status, 200); assert.equal(kitchen.status, 200);
    assert.equal(f.records('device_access').length, 0);
    const frontHeaders = { 'x-device-access': front.access_token }, kitchenHeaders = { 'x-device-access': kitchen.access_token };
    assert.equal((await state(f, frontHeaders)).menu.beer.name, 'Cerveja');
    assert.deepEqual((await state(f, kitchenHeaders)).menu, {});
    for (const headers of [frontHeaders, kitchenHeaders]) {
      assert.notEqual((await f.call({ action: 'cash.close', id: 'cash', counted_cash: 0 }, headers)).status, 200);
      assert.notEqual((await f.call({ action: 'menu.delete', id: 'beer' }, headers)).status, 200);
    }
    assert.equal((await state(f, { authorization: `Bearer ${front.access_token}` })).status, 401);
    assert.equal((await access(f, 'admin')).status, 400);
    f.put('menu', 'food', { name: 'Porcao', category: 'Comidas', price: 20 });
    const checkout = await f.call({ action: 'sale.checkout', customer_name: 'Cliente', payment_method: 'Digital', items: [{ menu_id: 'food', quantity: 1 }] }, frontHeaders);
    assert.equal(checkout.status, 200); assert.equal(f.records('kitchen')[0].created_by, 'Caixa principal');
    assert.equal((await f.call({ action: 'kitchen.received', ids: [checkout.id] }, kitchenHeaders)).status, 200);
    for (const status of ['started', 'ready']) assert.equal((await f.call({ action: 'kitchen.status', id: checkout.id, status }, kitchenHeaders)).status, 200);
    assert.equal((await state(f, frontHeaders)).kitchen[checkout.id].status, 'ready');
    assert.equal((await f.call({ action: 'kitchen.status', id: checkout.id, status: 'delivered' }, frontHeaders)).status, 200);
    f.env.ORDER_LIVE = {};
    for (const headers of [frontHeaders, kitchenHeaders]) {
      assert.equal((await worker.fetch(new Request('http://localhost/api/live-ticket', { method: 'POST', headers }), f.env)).status, 200);
    }
  } finally { f.sqlite.close(); }
});

test('operational access cannot be altered, used as a live ticket, or retained past expiry', async () => {
  const token = await operationAccess('front', 'secret', 1000);
  assert.equal((await verifyOperationAccess(token, 'secret', 1001)).role, 'front');
  assert.equal(await verifyOperationAccess(token, 'other', 1001), null);
  assert.equal(await verifyOperationAccess(token + 'x', 'secret', 1001), null);
  assert.equal(await verifyOperationAccess(token, 'secret', 86401001), null);
  assert.equal(await verifyOperationAccess('wrong.token', 'secret', 1001), null);
  await assert.rejects(operationAccess('admin', 'secret'));
});

function screen() {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), requests = [], reads = [], draws = [];
  const context = {
    app: {}, nav: {}, module: null, page: null, token: '', deviceToken: 'legacy-device', deviceRole: 'kitchen', originToken: 'old-staff', staffDeviceManaged: true, inviteToken: '',
    knownKitchenOrderIds: null, knownFrontKitchenStatuses: null,
    syncIdentity: '', syncCursor: null, syncVersions: new Map(), syncGeneration: 0, loadPending: null,
    historyLoads: new Map(), historyPages: new Map(), refreshTimer: null, clearInterval() {}, data: {},
    localStorage: { setItem() {}, removeItem() {} }, liveSync: { stop() {} },
    load: async () => { reads.push(context.module); context.syncIdentity=context.authIdentity();context.syncCursor=1;context.data={role:context.deviceRole}; }, draw: () => draws.push(context.module),showSyncError:assert.fail,
    prepareKitchenAlerts() {}, prepareFrontAlerts() {}, kitchenViewOpen: () => context.module === 'Cozinha', readyAlertsOpen: () => false,
    fiadoLabels: value => value,
    fetch: async (_, options) => { const { role } = JSON.parse(options.body); requests.push(role); return { ok: true, json: async () => ({ access_token: `operation.${role}`, role,expires_at:Date.now()+86400000 }) }; },
  };
  context.authIdentity=()=>JSON.stringify([context.token,context.deviceToken,context.originToken]);
  const saved=new Map();
  context.operationAccessCache=createOperationAccessCache({request:(...args)=>context.fetch(...args),storage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)}});
  runInNewContext(source.slice(source.indexOf('function portal(){'), source.indexOf('function sharedStaffAccessDialog(')) + '\n' + source.split('\n').find(line => line.startsWith('function loginPage(){')), context);
  return { context, requests, reads, draws };
}

test('entry always shows the module choices, and operational tabs switch without a password', async () => {
  const h = screen(), c = h.context; c.portal();
  assert.match(c.app.innerHTML, /Escolha onde entrar/); assert.match(c.app.innerHTML, /data-module="Cozinha"/);
  assert.doesNotMatch(c.app.innerHTML, /<form|type="password"|device-claim/);
  await c.enterModule('Cozinha'); assert.equal(c.module, 'Cozinha'); assert.equal(c.deviceRole, 'kitchen'); assert.equal(c.originToken, '');
  await c.enterModule('Frente de caixa'); assert.equal(c.module, 'Frente de caixa'); assert.equal(c.deviceRole, 'front');
  await c.enterModule('Admin'); assert.equal(c.module, 'Admin'); assert.equal(c.deviceToken, '');
  assert.deepEqual(h.requests.sort(), ['front', 'kitchen']); assert.deepEqual(h.reads, ['Cozinha', 'Frente de caixa']);
  assert.match(c.loginPage(), /type="password"/); assert.doesNotMatch(c.loginPage(), /device-claim/);
  c.setupNav([]); assert.match(c.nav.innerHTML, /data-home/);assert.doesNotMatch(c.nav.innerHTML,/data-module/);
});

test('a slow previous selection cannot override the last operational tab selected', async () => {
  const h = screen(), c = h.context, pending = [];
  c.fetch = (_, options) => new Promise(resolve => pending.push(() => resolve({ ok: true, json: async () => ({ role: JSON.parse(options.body).role, access_token: JSON.parse(options.body).role,expires_at:Date.now()+86400000 }) })));
  const kitchen = c.enterModule('Cozinha'), front = c.enterModule('Frente de caixa');
  pending[1](); await front; pending[0](); await kitchen;
  assert.equal(c.module, 'Frente de caixa'); assert.equal(c.deviceRole, 'front');
  assert.deepEqual(h.draws, ['Cozinha','Frente de caixa']);
});

test('module selection draws immediately before access and full state requests complete',async()=>{
 const h=screen(),c=h.context;let finish;
 c.fetch=()=>new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({role:'kitchen',access_token:'kitchen'})})});
 const pending=c.enterModule('Cozinha');
 assert.deepEqual(h.draws,['Cozinha']);assert.equal(h.reads.length,0);
 finish();await pending;assert.deepEqual(h.reads,['Cozinha']);
});
