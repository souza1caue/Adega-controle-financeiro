import test from 'node:test';
import assert from 'node:assert/strict';
import { stockEntryDefaults, stockEntryPayload, findStockEntryProducts } from '../public/stock-entry.js';
import { fixture } from './fixture.mjs';

test('three packs of twelve with total paid create 36 units at the correct cost', async () => {
  const f = fixture();
  const entry = stockEntryPayload({ name: 'Heineken', quantity: '3', purchase_unit: 'package', units_per_package: '12', total_paid: '180', supplier: 'Fornecedor' });
  assert.equal(entry.amount, 36);
  assert.equal(entry.unitCost, 5);
  const result = await f.call({ action: 'stock.purchase.batch', items: [entry.line] });
  assert.equal(result.status, 200, result.error);
  const item = f.records('stock_items').find(item => item.name === 'Heineken');
  assert.equal(f.balance(item.id), 36);
  assert.equal(item.cost_price, 5);
  assert.equal(item.supplier, 'Fornecedor');
  assert.equal(result.total_cost, 180);
  assert.equal(item.units_per_package, 12);
  assert.equal(stockEntryDefaults(item).purchase_unit, 'package');
});

test('existing stock uses saved units, packaging and weighted cost without creating another product', async () => {
  const f = fixture();
  f.put('stock_items', 'beer', { name: 'Cerveja', unit: 'lata', cost_price: 3, supplier: 'Original', stock_minimum: 4, purchase_unit: 'package', units_per_package: 12 });
  f.sqlite.exec("UPDATE stock_balances SET quantity=12 WHERE id='beer'");
  const item = f.records('stock_items')[0];
  const entry = stockEntryPayload({ ...stockEntryDefaults(item), id: 'beer', quantity: '2', total_paid: '120' }, { beer: item });
  assert.equal(entry.amount, 24);
  assert.equal(entry.line.unit, 'lata');
  const result = await f.call({ action: 'stock.purchase.batch', items: [entry.line] });
  assert.equal(result.status, 200, result.error);
  assert.equal(f.records('stock_items').length, 1);
  assert.equal(f.balance('beer'), 36);
  assert.equal(f.records('stock_items')[0].supplier, 'Original');
  assert.equal(f.records('stock_items')[0].stock_minimum, 4);
  assert.equal(f.records('stock_items')[0].cost_price, 4.33);
});

test('direct kilos, liters and legacy grams/milliliters agree with saved stock measures', async () => {
  for (const [unit, quantity, total] of [['kg', '2.5', '50'], ['L', '3', '24'], ['g', '250', '10'], ['ml', '750', '12']]) {
    const f = fixture();
    f.put('stock_items', 'bulk', { name: `Item ${unit}`, unit, cost_price: 0 });
    f.sqlite.prepare('INSERT INTO stock_balances(id,quantity) VALUES(?,0)').run('bulk');
    const stocks = Object.fromEntries(f.records('stock_items').map(item => [item.id, item]));
    const entry = stockEntryPayload({ id: 'bulk', quantity, total_paid: total, purchase_unit: 'direct' }, stocks);
    const result = await f.call({ action: 'stock.purchase.batch', items: [entry.line] });
    assert.equal(result.status, 200, result.error);
    assert.equal(f.balance('bulk'), Number(quantity));
    assert.equal(result.total_cost, Number(total));
  }
});

test('packaged ingredients convert grams to kilos and milliliters to liters and remember contents', async () => {
  for (const [unit, contentUnit, content, amount] of [['kg', 'g', '325', 1.95], ['L', 'ml', '750', 4.5]]) {
    const f = fixture();
    const entry = stockEntryPayload({ name: `Embalado ${unit}`, unit, stock_category: 'Comida', purchase_unit: 'package', quantity: '2', units_per_package: '3', content_per_unit: content, content_unit: contentUnit, total_paid: '90' });
    assert.ok(Math.abs(entry.amount - amount) < 1e-9);
    const result = await f.call({ action: 'stock.purchase.batch', items: [entry.line] });
    assert.equal(result.status, 200, result.error);
    const item = f.records('stock_items').find(item => item.name === entry.line.name);
    assert.ok(Math.abs(f.balance(item.id) - amount) < 1e-9);
    const defaults = stockEntryDefaults(item);
    assert.equal(defaults.content_per_unit, Number(content));
    assert.equal(defaults.content_unit, contentUnit);
    assert.equal(defaults.units_per_package, 3);
  }
});

test('entry requires quantity and total paid and never silently guesses a missing cost', () => {
  const valid = { name: 'Novo', quantity: '3', total_paid: '12' };
  for (const patch of [{ quantity: '' }, { quantity: '0' }, { quantity: '-1' }, { quantity: 'abc' }, { total_paid: '' }, { total_paid: null }, { total_paid: '-5' }, { total_paid: 'abc' }, { purchase_unit: 'package', units_per_package: '0' }, { purchase_unit: 'package', units_per_package: '2.5' }, { purchase_unit: 'package', units_per_package: '12', quantity: '1.5' }, { unit: 'kg', purchase_unit: 'package', units_per_package: '1', content_per_unit: '', content_unit: 'g' }, { unit: 'kg', purchase_unit: 'package', units_per_package: '1', content_per_unit: '1', content_unit: 'L' }]) assert.throws(() => stockEntryPayload({ ...valid, ...patch }));
  assert.equal(stockEntryPayload({ ...valid, total_paid: '0' }).unitCost, 0);
});

test('search ignores accents, matches all words and ranks frequent products first', () => {
  const stocks = { a: { name: 'Água mineral', purchase_count: 2 }, b: { name: 'Água com gás', purchase_count: 5 }, c: { name: 'Cerveja', purchase_count: 8 } };
  assert.deepEqual(findStockEntryProducts(stocks, 'agua').map(([id]) => id), ['b', 'a']);
  assert.deepEqual(findStockEntryProducts(stocks, 'agua gas').map(([id]) => id), ['b']);
  assert.deepEqual(findStockEntryProducts(stocks, '').map(([id]) => id), ['c', 'b', 'a']);
  assert.throws(() => stockEntryPayload({ name: ' AGUA MINERAL ', quantity: 1, total_paid: 1 }, stocks), /já existe/);
});

test('batch API rejects duplicate names atomically and supports consecutive save-and-add entries', async () => {
  const f = fixture();
  const create = name => stockEntryPayload({ name, quantity: '2', total_paid: '10' }).line;
  const rejected = await f.call({ action: 'stock.purchase.batch', items: [create('Novo'), create('  cerveja  ')] });
  assert.equal(rejected.status, 400);
  assert.equal(f.records('stock_purchases').length, 0);
  assert.equal(f.records('stock_items').length, 1);
  assert.equal((await f.call({ action: 'stock.purchase.batch', items: [create('Novo')] })).status, 200);
  assert.equal((await f.call({ action: 'stock.purchase.batch', items: [create('Outro')] })).status, 200);
  assert.equal(f.records('stock_purchases').length, 2);
});
