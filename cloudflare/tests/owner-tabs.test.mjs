import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixture } from './fixture.mjs';

function ready() {
  const f = fixture();
  f.sqlite.exec("UPDATE stock_balances SET quantity=20 WHERE id='beer'");
  f.put('device_access', 'front', { role: 'front', label: 'Caixa', token_hash: createHash('sha256').update('front-token').digest('hex') });
  return f;
}
const front = { 'x-device-access': 'front-token' };
const open = (f, owner_pricing = true) => f.call({ action: 'account.create', id: 'tab', account_type: 'tab', customer_name: 'Proprietário', owner_pricing }, front);
const order = (f, extra = {}) => f.call({ action: 'sale.checkout', destination: 'tab', account_id: 'tab', items: [{ menu_id: 'beer', quantity: 2 }], ...extra }, front);

test('front opens owner tab, charges recipe cost, deducts stock and settles at cost', async () => {
  const f = ready();
  assert.equal((await open(f)).status, 200);
  assert.equal(f.records('accounts')[0].owner_pricing, true);
  assert.equal((await order(f)).status, 200);
  const tab = f.records('accounts')[0];
  assert.equal(tab.account_type, 'tab');
  assert.equal(tab.cash_session_id, 'cash');
  assert.equal(tab.items[0].price, 3);
  assert.equal(tab.items[0].quantity, 2);
  assert.equal(f.records('sales')[0].price, 3);
  assert.equal(f.records('sales')[0].payment_method, 'Comanda');
  assert.equal(f.balance('beer'), 18);
  const payment = await f.call({ action: 'account.receivePayment', id: 'tab', amount: 6, payment_method: 'Digital' }, front);
  assert.equal(payment.status, 200);
  assert.equal(payment.balance_after, 0);
  assert.equal(f.records('accounts')[0].status, 'closed');
  assert.equal(f.records('account_payments')[0].amount, 6);
});

test('regular and legacy tabs keep menu prices despite caller requesting owner pricing', async () => {
  for (const legacy of [false, true]) {
    const f = ready();
    assert.equal((await open(f, false)).status, 200);
    if (legacy) { const tab = f.records('accounts')[0]; delete tab.owner_pricing; f.put('accounts', 'tab', tab); }
    assert.equal((await order(f, { owner_pricing: true })).status, 200);
    assert.equal(f.records('accounts')[0].items[0].price, 8);
    assert.equal(f.records('sales')[0].price, 8);
  }
});

test('new tab created by checkout supports owner cost and cost fallback without recipe', async () => {
  const f = ready();
  f.put('menu', 'snack', { name: 'Petisco', category: 'Comidas', price: 15, cost_price: 4.126 });
  const result = await f.call({ action: 'sale.checkout', destination: 'tab', owner_pricing: true, customer_name: 'Dono', items: [{ menu_id: 'snack', quantity: 3 }] }, front);
  assert.equal(result.status, 200);
  assert.equal(f.records('accounts')[0].owner_pricing, true);
  assert.equal(f.records('accounts')[0].items[0].price, 4.13);
  assert.equal(f.records('sales')[0].price, 4.13);
  assert.equal(f.records('kitchen')[0].customer_name, 'Dono');
});

test('missing or partially missing costs reject complete order without partial writes', async () => {
  for (const partial of [false, true]) {
    const f = ready();
    await open(f);
    f.put('stock_items', 'unknown', { name: 'Insumo', cost_price: 0 });
    f.put('recipes', 'beer', { components: [...(partial ? [{ stock_item_id: 'beer', quantity: 1 }] : []), { stock_item_id: 'unknown', quantity: 1 }] });
    const result = await order(f);
    assert.equal(result.status, 400);
    assert.match(result.error, /custo/);
    assert.equal(f.records('accounts')[0].items.length, 0);
    assert.equal(f.records('sales').length, 0);
    assert.equal(f.records('stock_movements').length, 0);
    assert.equal(f.balance('beer'), 20);
  }
});

test('owner tab manual product entry enforces cost and rejects unconfigured manual items', async () => {
  const f = ready();
  await open(f);
  const payload = { action: 'account.addItem', id: 'tab', description: 'Cerveja', quantity: 2, price: 100 };
  assert.equal((await f.call(payload, front)).status, 400);
  assert.equal((await f.call({ ...payload, menu_id: 'beer' }, front)).status, 200);
  assert.equal(f.records('accounts')[0].items[0].price, 3);
  assert.equal(f.records('sales')[0].price, 3);
  assert.equal(f.balance('beer'), 18);
});

test('owner pricing can change on empty tabs and locks once consumption exists', async () => {
  const f = ready();
  await open(f, false);
  const edit = { action: 'account.update', id: 'tab', account_type: 'tab', customer_name: 'Dono', owner_pricing: true };
  assert.equal((await f.call(edit, front)).status, 200);
  await order(f);
  const result = await f.call({ ...edit, owner_pricing: false }, front);
  assert.equal(result.status, 400);
  assert.equal(f.records('accounts')[0].owner_pricing, true);
  assert.equal((await f.call({ action: 'account.update', id: 'tab', customer_name: 'Novo nome' }, front)).status, 200);
  assert.equal(f.records('accounts')[0].owner_pricing, true);
});

test('price is captured at launch and later cost changes do not rewrite earlier entries', async () => {
  const f = ready();
  await open(f);
  await order(f);
  f.put('stock_items', 'beer', { name: 'Cerveja', unit: 'un', cost_price: 4 });
  await order(f);
  assert.deepEqual(f.records('accounts')[0].items.map(item => item.price), [3, 4]);
});

test('owner tabs require open cash session', async () => {
  const f = ready();
  f.sqlite.exec("DELETE FROM records WHERE kind='cash'");
  assert.equal((await open(f)).status, 400);
  assert.equal(f.records('accounts').length, 0);
});

test('cancelling consumption restores stock and removes the cost-priced balance', async () => {
  const f = ready();
  await open(f);
  await order(f);
  const item = f.records('accounts')[0].items[0];
  const result = await f.call({ action: 'account.cancelItem', id: 'tab', item_id: item.id, reason: 'Pedido incorreto' }, front);
  assert.equal(result.status, 200);
  assert.equal(f.balance('beer'), 20);
  assert.ok(f.records('accounts')[0].items[0].cancelled_at);
  assert.equal(f.records('accounts')[0].items[0].price, 3);
  assert.ok(f.records('sales')[0].voided_at);
});

test('opening form offers owner option and editing consumed tabs preserves their type', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('accountFormDialog=function(id=""){');
  const code = source.slice(start, source.indexOf('accountDialog=function(id){', start));
  let html;
  const context = { module: 'Frente de caixa', data: { accounts: {} }, esc: value => value, openModal: value => { html = value; } };
  runInNewContext(code + '\naccountFormDialog()', context);
  assert.match(html, /type="checkbox" name="owner_pricing"/);
  assert.match(html, /Comanda de proprietário/);
  context.data.accounts.tab = { account_type: 'tab', owner_pricing: true, items: [{ price: 3 }] };
  runInNewContext(code + '\naccountFormDialog("tab")', context);
  assert.match(html, /type="hidden" name="owner_pricing" value="true"/);
  assert.doesNotMatch(html, /type="checkbox" name="owner_pricing"/);
});

test('order preview and checkout show rounded cost totals with quantities and fallback', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const names = ['menuCost', 'ownerMenuPrice', 'tabOrderPrice', 'tabOrderTotal', 'checkoutOwnerPricing', 'checkoutChargedTotal'];
  const functions = names.map(name => source.split('\n').find(line => line.startsWith(`function ${name}(`))).join('\n');
  const context = { data: { accounts: { tab: { account_type: 'tab', owner_pricing: true } }, menu: { beer: { price: 8 }, snack: { price: 15, cost_price: 4.126 } }, recipes: { beer: { components: [{ stock_item_id: 'beer', quantity: 1 }] } }, stock_items: { beer: { cost_price: 3 } } }, tabOrderAccountId: 'tab', tabOrderLines: () => [['beer', { quantity: 2 }], ['snack', { quantity: 3 }]], cartLines: () => [['beer', { quantity: 2 }], ['snack', { quantity: 3 }]], cartTotal: () => 61, form: { elements: { destination: { value: 'account' }, account_id: { value: 'tab' } } } };
  const result = runInNewContext(functions + '\n[tabOrderTotal(),checkoutChargedTotal(form)]', context);
  assert.equal(result[0], 18.39);
  assert.equal(result[1], 18.39);
  context.data.accounts.tab.owner_pricing = false;
  assert.equal(runInNewContext(functions + '\ntabOrderTotal()', context), 61);
});
