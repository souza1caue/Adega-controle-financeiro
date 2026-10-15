import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { fixture } from './fixture.mjs';

test('staff cost needs no employee, edits one record, and does not create cash withdrawals or payment obligations', async () => {
  const f = fixture();
  let result = await f.call({ action: 'staff.cost.save', id: 'daily-cost', amount: 200 });
  assert.equal(result.status, 200);
  assert.equal(f.records('employees').length, 0);
  assert.equal(f.records('staff_shifts')[0].employee_name, 'Funcionários');
  assert.equal(f.records('staff_shifts')[0].cost_only, true);
  result = await f.call({ action: 'staff.cost.save', id: 'daily-cost', amount: 250, description: 'Equipe do dia' });
  assert.equal(result.status, 200);
  assert.equal(f.records('staff_shifts').length, 1);
  assert.equal(f.records('staff_shifts')[0].daily_rate, 250);
  assert.equal((f.records('cash')[0].movements || []).length, 0);
  assert.equal((await f.call({ action: 'cash.close', id: 'cash', counted_cash: 0, counted_account: 0 })).status, 200);
  assert.equal((await f.call({ action: 'staff.shift.cancel', id: 'daily-cost' })).status, 400);
  assert.equal((await f.call({ action: 'staff.cost.save', id: 'daily-cost', amount: 300 })).status, 400);
});

test('invalid, unauthorized, and historical cost edits do not change stored costs', async () => {
  const f = fixture();
  for (const amount of [0, -1, 'abc']) assert.equal((await f.call({ action: 'staff.cost.save', amount })).status, 400);
  assert.equal((await f.call({ action: 'staff.cost.save', amount: 100 }, {})).status, 401);
  f.put('device_access', 'front', { role: 'front', token_hash: createHash('sha256').update('front').digest('hex') });
  assert.equal((await f.call({ action: 'staff.cost.save', amount: 100 }, { 'x-device-access': 'front' })).status, 403);
  f.put('staff_shifts', 'legacy', { employee_name: 'João', group: 'Adega', daily_rate: 50, status: 'paid', cash_session_id: 'cash' });
  assert.equal((await f.call({ action: 'staff.cost.save', id: 'legacy', amount: 100 })).status, 400);
  assert.equal(f.records('staff_shifts')[0].daily_rate, 50);
  await f.call({ action: 'staff.cost.save', id: 'new-cost', amount: 100 });
  assert.equal((await f.call({ action: 'staff.shift.cancel', id: 'new-cost' })).status, 200);
  assert.equal((await f.call({ action: 'staff.cost.save', id: 'new-cost', amount: 150 })).status, 400);
});

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function screen(data) {
  const context = {
    data, staffCashId: 'cash', entries: value => Object.entries(value || {}),
    activeCash: () => ['cash', data.cash.cash],
    hostedEventActualCost: (_, event) => event.actual_cost || 0,
    esc: value => String(value).replaceAll('<', '&lt;'), money: value => `R$ ${value}`, date: value => value,
    heading: (title, action) => `<h1>${title}</h1>${action}`, empty: value => value,
  };
  runInNewContext(source.slice(source.indexOf('function dayOperatingCosts('), source.indexOf('function stockHistoryEntry(')), context);
  return context;
}

test('day total uses real consumption cost, includes legacy records, and counts event fees once', () => {
  const context = screen({
    cash: { cash: { status: 'open', opened_at: '2026-10-14' }, previous: { status: 'closed', opened_at: '2026-10-13' } },
    staff_shifts: {
      cost: { cash_session_id: 'cash', group: 'Funcionários', daily_rate: 200, cost_only: true },
      legacy: { cash_session_id: 'cash', group: 'Cozinha', daily_rate: 50, status: 'paid' },
      cancelled: { cash_session_id: 'cash', group: 'Adega', daily_rate: 999, status: 'cancelled' },
      fee: { cash_session_id: 'cash', group: 'Evento', daily_rate: 300, hosted_event_id: 'event' },
      old: { cash_session_id: 'previous', group: 'Adega', daily_rate: 999 },
    },
    stock_events: {
      food: { cash_session_id: 'cash', event_type: 'staff_consumption', total_cost: 25, revenue_not_realized: 100 },
      cancelled: { cash_session_id: 'cash', event_type: 'staff_consumption', total_cost: 999, cancelled_at: 'now' },
      old: { cash_session_id: 'previous', event_type: 'staff_consumption', total_cost: 999 },
    },
    hosted_events: { event: { cash_session_id: 'cash', event_mode: 'contracted', fee_shift_id: 'fee', fee_amount: 300, actual_cost: 40 }, old: { cash_session_id: 'previous', actual_cost: 999 } },
  });
  const costs = context.dayOperatingCosts('cash');
  assert.equal(costs.employeeCost, 250);
  assert.equal(costs.consumptionCost, 25);
  assert.equal(costs.eventCost, 340);
  assert.equal(costs.total, 615);
  const html = context.staffPageSimple();
  assert.match(html, /Custo total de funcionamento/);
  assert.match(html, /R\$ 615/);
  assert.match(html, /data-form="staff-cost-total"/);
  assert.doesNotMatch(html, /data-new-employee|data-edit-employee|data-staff-add|data-new-staff-shift|staff-directory/);
});

test('unlinked event fee is included and historical screen disables new registrations', () => {
  const context = screen({ cash: { cash: { status: 'closed', opened_at: '2026-10-13' } }, staff_shifts: {}, stock_events: {}, hosted_events: { event: { cash_session_id: 'cash', event_mode: 'contracted', fee_amount: 100, actual_cost: 15 } } });
  context.activeCash = () => null;
  assert.equal(context.dayOperatingCosts('cash').total, 115);
  assert.match(context.staffPageSimple(), /name="amount"[^>]+disabled/);
  assert.match(context.staffPageSimple(), /data-staff-consumption disabled/);
});

test('staff and event consumption send only food to kitchen and cancellation restores stock', async () => {
  for (const event of [false, true]) {
    const f = fixture();
    f.sqlite.exec("UPDATE stock_balances SET quantity=10 WHERE id='beer'");
    f.put('menu', 'food', { name: 'Lanche', price: 20, category: 'Comidas' });
    f.put('recipes', 'food', { components: [{ stock_item_id: 'beer', quantity: 1 }] });
    if (event) f.put('hosted_events', 'party', { simple_event: true, name: 'Festa', cash_session_id: 'cash', status: 'open', consumption_mode: 'products' });
    const result = await f.call({ action: 'stock.event.create', event_type: 'staff_consumption', hosted_event_id: event ? 'party' : '', items: [{ menu_id: 'food', quantity: 2 }, { menu_id: 'beer', quantity: 1 }] });
    assert.equal(result.status, 200);
    assert.equal(f.balance('beer'), 7);
    assert.equal(f.records('sales').length, 0);
    const order = f.records('kitchen')[0];
    assert.equal(order.status, 'pending');
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].menu_id, 'food');
    assert.equal(order.quantity, 2);
    assert.equal(order.stock_event_id, result.id);
    assert.equal(order.hosted_event_id, event ? 'party' : '');
    assert.equal((await f.call({ action: 'cash.close', id: 'cash', counted_cash: 0, counted_account: 0 })).status, 400);
    assert.equal((await f.call({ action: 'stock.event.cancel', id: result.id, reason: 'Pedido errado' })).status, 200);
    assert.equal(f.balance('beer'), 10);
    assert.equal(f.records('kitchen')[0].status, 'cancelled');
  }
});

test('daily staff total replaces the displayed cost while preserving historical shifts', async () => {
  const f = fixture();
  f.put('staff_shifts', 'legacy', { group: 'Adega', daily_rate: 100, cash_session_id: 'cash', status: 'paid' });
  for (const amount of [250, 80, 0]) {
    assert.equal((await f.call({ action: 'staff.cost.total', amount })).status, 200);
    assert.equal(f.records('staff_shifts').reduce((sum, item) => sum + item.daily_rate, 0), amount);
    assert.equal(f.records('staff_shifts').length, 2);
  }
});

test('staff consumption accepts zero balance and cancellation restores it', async () => {
  const f = fixture();
  f.put('menu', 'food', { name: 'Lanche', price: 20, category: 'Comidas' });
  f.put('recipes', 'food', { components: [{ stock_item_id: 'beer', quantity: 1 }] });
  const result = await f.call({ action: 'stock.event.create', event_type: 'staff_consumption', items: [{ menu_id: 'food', quantity: 2 }] });
  assert.equal(result.status, 200);
  assert.equal(f.balance('beer'), -2);
  assert.equal(f.records('stock_movements')[0].type, 'staff_consumption');
  assert.equal(f.records('kitchen')[0].items[0].quantity, 2);
  assert.equal(f.records('sales').length, 0);
  assert.equal((await f.call({ action: 'stock.event.cancel', id: result.id, reason: 'Teste' })).status, 200);
  assert.equal(f.balance('beer'), 0);
});

test('staff selection adds, searches and removes items with zero stock', () => {
  let html = '';
  const context = {
    data: { menu: { food: { name: 'Lanche', category: 'Comidas' } }, recipes: { food: { components: [{ stock_item_id: 'ingredient', quantity: 1 }] } }, stock_items: { ingredient: { cost_price: 3 } } },
    staffConsumptionCart: {}, staffConsumptionSearch: '', staffConsumptionSubmitting: false, staffConsumptionEventId: '',
    productStockState: () => ({ available: 0, tracked: true }),
    saleStockBlocked: state => Boolean(state.invalid), saleStockLabel: () => 'Sem saldo',
    entries: Object.entries, esc: String, money: value => `R$ ${value}`, saleGroup: () => 'Comidas', empty: String,
    modal: { classList: { add() {} } }, openModal: value => { html = value; }, toast: () => assert.fail('Unexpected stock block'),
  };
  runInNewContext(source.slice(source.indexOf('function menuCost('), source.indexOf('function tabOrderDialog(')), context);
  context.renderStaffConsumptionDialog();
  assert.match(html, /data-staff-consumption-add="food"/);
  assert.doesNotMatch(html, /data-staff-consumption-add="food" disabled/);
  context.changeStaffConsumption('food', 1);
  assert.equal(context.staffConsumptionCart.food.quantity, 1);
  assert.equal(context.staffConsumptionTotal(), 3);
  context.staffConsumptionSearch = 'lan';
  context.renderStaffConsumptionDialog();
  assert.match(html, /data-staff-consumption-add="food"/);
  assert.equal(context.staffConsumptionCart.food.quantity, 1);
  context.changeStaffConsumption('food', -1);
  assert.equal(Object.keys(context.staffConsumptionCart).length, 0);
});
