import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisclosureState } from '../public/disclosure-state.js';

function section(id, { open = false, parent = null, classes = [], summary = '' } = {}) {
  return {
    dataset: id ? { disclosureKey: id } : {}, classList: classes, open,
    parentElement: { closest: () => parent },
    querySelector: () => ({ textContent: summary }),
    matches: selector => classes.some(name => selector.split(',').includes('.' + name)),
  };
}
function screen(nodes) {
  return { querySelectorAll: () => nodes, contains: element => nodes.includes(element) };
}

test('refresh preserves independently opened and closed items through repeated updates and sorting', () => {
  const state = createDisclosureState();
  let nodes = [section('beer', { open: true }), section('food')];
  state.restore(screen(nodes), 'Admin/cash');
  for (let i = 0; i < 10; i++) {
    state.capture(screen(nodes));
    nodes = [section('food', { open: true }), section('new'), section('beer')];
    state.restore(screen(nodes), 'Admin/cash');
    assert.equal(nodes[0].open, false);
    assert.equal(nodes[2].open, true);
  }
  nodes[2].open = false;
  state.capture(screen(nodes));
  nodes = [section('beer', { open: true })];
  state.restore(screen(nodes), 'Admin/cash');
  assert.equal(nodes[0].open, false);
});

test('nested histories do not share state between current cash and reports, or between pages', () => {
  const state = createDisclosureState();
  const current = section(null, { classes: ['cash-current-sales'] });
  const reports = section(null, { classes: ['cash-reports'] });
  const a = section('beer', { open: true, parent: current });
  const b = section('beer', { parent: reports });
  state.restore(screen([current, reports, a, b]), 'cash');
  state.capture(screen([current, reports, a, b]));
  const nextA = section('beer', { parent: current });
  const nextB = section('beer', { open: true, parent: reports });
  state.restore(screen([current, reports, nextB, nextA]), 'cash');
  assert.equal(nextA.open, true);
  assert.equal(nextB.open, false);
  const stock = section('beer');
  state.restore(screen([stock]), 'stock');
  assert.equal(stock.open, false);
});

test('explicit page flags retain control over filters, reports, stock and kitchen histories', () => {
  const state = createDisclosureState();
  const classes = ['cash-reports', 'cash-financial-details', 'overview-period-details',
    'overview-sales-history', 'cash-current-sales', 'settled-accounts-history',
    'stock-history', 'kitchen-history', 'front-kitchen-history'];
  const old = classes.map(name => section(null, { classes: [name], open: true }));
  state.restore(screen(old), 'cash');
  state.capture(screen(old));
  const next = classes.map(name => section(null, { classes: [name] }));
  state.restore(screen(next), 'cash');
  assert.ok(next.every(element => !element.open));
});

test('static menus retain state and new rows do not inherit a removed row state', () => {
  const state = createDisclosureState();
  const options = section(null, { classes: ['pos-options'], open: true });
  const removed = section('deleted-item', { open: true });
  state.restore(screen([options, removed]), 'sales');
  state.capture(screen([options, removed]));
  const next = [section(null, { classes: ['pos-options'] }), section('new-item')];
  state.restore(screen(next), 'sales');
  assert.equal(next[0].open, true);
  assert.equal(next[1].open, false);
});
