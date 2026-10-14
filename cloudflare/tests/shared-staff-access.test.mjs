import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, worker } from './fixture.mjs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

async function claim(f, token) {
  const response = await worker.fetch(new Request('http://localhost/api/staff/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite_token: token }) }), f.env);
  return { status: response.status, ...await response.json() };
}
async function state(f, headers) {
  const response = await worker.fetch(new Request('http://localhost/api/state', { headers }), f.env);
  return { status: response.status, ...await response.json() };
}
const order = { action: 'sale.checkout', destination: 'sale', payment_method: 'Dinheiro', items: [{ menu_id: 'beer', quantity: 1 }] };

test('one shared QR activates multiple independent names without employee registration', async () => {
  const f = fixture();
  f.sqlite.exec("UPDATE stock_balances SET quantity=20 WHERE id='beer'");
  const qr = await f.call({ action: 'staff.access.shared' });
  assert.equal(qr.status, 200);
  assert.equal((await f.call({ action: 'staff.access.shared' })).access_token, qr.access_token);
  const a = await claim(f, qr.access_token), b = await claim(f, qr.access_token);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.notEqual(a.access_token, b.access_token);
  const ha = { 'x-staff-access': a.access_token }, hb = { 'x-staff-access': b.access_token };
  assert.equal((await state(f, ha)).front_identity.source_name, '');
  assert.equal((await f.call(order, ha)).status, 400);
  assert.equal(f.records('sales').length, 0);
  assert.equal((await f.call({ action: 'front.identify', name: '  João  ' }, ha)).status, 200);
  assert.equal((await f.call({ action: 'front.identify', name: 'Maria' }, hb)).status, 200);
  assert.equal((await f.call({ action: 'front.identify', name: 'Outro nome' }, ha)).status, 400);
  assert.equal((await f.call(order, ha)).status, 200);
  assert.equal((await f.call(order, hb)).status, 200);
  assert.deepEqual(f.records('sales').map(sale => sale.source_name).sort(), ['João', 'Maria']);
  assert.equal(f.records('employees').length, 0);
  assert.equal(f.records('staff_shifts').length, 0);
  const snapshot = await state(f, ha);
  assert.equal(snapshot.front_identity.source_name, 'João');
  assert.equal(snapshot.staff_access, undefined);
  assert.equal(JSON.stringify(snapshot).includes(qr.access_token), false);
  assert.equal((await f.call({ action: 'cash.open', opening_amount: 0 }, ha)).status, 403);
});

test('closing cash revokes QR and named sessions while preserving historical attribution', async () => {
  const f = fixture();
  f.sqlite.exec("UPDATE stock_balances SET quantity=20 WHERE id='beer'");
  const qr = await f.call({ action: 'staff.access.shared' });
  const session = await claim(f, qr.access_token), headers = { 'x-staff-access': session.access_token };
  await f.call({ action: 'front.identify', name: 'Ana' }, headers);
  assert.equal((await f.call(order, headers)).status, 200);
  assert.equal((await f.call({ action: 'cash.close', id: 'cash', counted_cash: 8, counted_account: 0 })).status, 200);
  assert.ok(f.records('staff_access').every(access => access.revoked_reason === 'cash_closed'));
  assert.equal((await claim(f, qr.access_token)).status, 401);
  assert.equal((await f.call(order, headers)).status, 400);
  f.put('cash', 'next', { status: 'open', opened_at: new Date().toISOString() });
  const nextQr = await f.call({ action: 'staff.access.shared' });
  assert.notEqual(nextQr.access_token, qr.access_token);
  const nextSession = await claim(f, nextQr.access_token);
  assert.equal((await state(f, { 'x-staff-access': nextSession.access_token })).front_identity.source_name, '');
  assert.equal(f.records('sales')[0].source_name, 'Ana');
});

test('main front station locks identity on server and records name on tab items and kitchen orders', async () => {
  const f = fixture();
  f.sqlite.exec("UPDATE stock_balances SET quantity=20 WHERE id='beer'");
  f.put('menu', 'beer', { name: 'Porção', category: 'Comidas', price: 8 });
  const identity = await f.call({ action: 'front.identify', name: 'Caue' });
  const headers = { authorization: 'Bearer test-token', 'x-front-identity': identity.access_token };
  assert.equal((await f.call({ action: 'front.identify', name: 'Maria' }, headers)).status, 400);
  const tab = await f.call({ action: 'account.create', id: 'tab', account_type: 'tab', customer_name: 'Mesa 1' }, headers);
  assert.equal(tab.status, 200);
  assert.equal((await f.call({ ...order, destination: 'tab', account_id: 'tab' }, headers)).status, 200);
  assert.equal(f.records('accounts')[0].items[0].created_by, 'Caue');
  assert.equal(f.records('kitchen')[0].created_by, 'Caue');
  assert.equal(f.records('sales')[0].source_name, 'Caue');
  f.put('cash', 'cash', { status: 'closed' });
  assert.equal((await state(f, headers)).front_identity, null);
});

test('blank and overlong names are rejected and shared QR requires admin and open cash', async () => {
  const f = fixture();
  assert.equal((await f.call({ action: 'front.identify', name: ' ' })).status, 400);
  assert.equal((await f.call({ action: 'front.identify', name: 'x'.repeat(81) })).status, 400);
  assert.equal((await f.call({ action: 'staff.access.shared' }, {})).status, 401);
  f.put('cash', 'cash', { status: 'closed' });
  assert.equal((await f.call({ action: 'staff.access.shared' })).status, 400);
});

test('front identity shows a text field before identification and a readonly name afterwards', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const context = { data: { front_identity: null }, activeCash: () => ['cash', { status: 'open' }], esc: value => String(value).replaceAll('<', '&lt;').replaceAll('"', '&quot;') };
  runInNewContext(source.slice(source.indexOf('function frontIdentityBar(){'), source.indexOf('\nfunction sharedStaffAccessDialog(')), context);
  assert.match(context.frontIdentityBar(), /data-form="front-identify"/);
  assert.match(context.frontIdentityBar(), /name="name"/);
  assert.doesNotMatch(context.frontIdentityBar(), /<select/);
  context.data.front_identity = { source_name: 'Ana <Silva>' };
  assert.match(context.frontIdentityBar(), /readonly/);
  assert.match(context.frontIdentityBar(), /Ana &lt;Silva>/);
  assert.doesNotMatch(context.frontIdentityBar(), /<form/);
  context.data.front_identity = null;
  context.activeCash = () => null;
  assert.match(context.frontIdentityBar(), /disabled/);
});
