import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function groupMovementHistory('), source.indexOf('\ncashPage=function(){', source.indexOf('function groupMovementHistory(')));
const context = { cashHistorySearch: '', esc: value => String(value).replaceAll('<', '&lt;'), money: value => `R$ ${value}`, date: value => value };
runInNewContext(helpers, context);
const sale = (extra = {}) => ({ description: 'Cerveja', menu_id: 'beer', quantity: 2, amount: 20, orderId: 'order-1', filter: 'sales', payment: 'Dinheiro', created_at: '2026-10-01T12:00:00Z', detail: 'Balcão', ...extra });

test('history sums units and counts distinct sales, including account sales without double counting receipts', () => {
  const receipt = { description: 'Cliente', filter: 'accounts', amount: 15 };
  const groups = context.groupMovementHistory([sale(), sale({ quantity: 3, amount: 30 }), sale({ quantity: 4, amount: 40, orderId: 'order-2', filter: 'accounts', payment: 'Fiado' }), receipt]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].quantity, 9);
  assert.equal(groups[0].saleCount, 2);
  assert.equal(groups[0].amount, 90);
  assert.equal(groups[0].entries.length, 3);
  assert.equal(groups[1], receipt);
});

test('groups use product IDs, retain legacy names, and are sorted by units sold', () => {
  const groups = context.groupMovementHistory([sale(), sale({ menu_id: 'other', quantity: 7 }), sale({ menu_id: null, description: 'Água', quantity: 1 }), sale({ menu_id: null, description: ' ÁGUA ', quantity: 3 })]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].quantity, 7);
  assert.equal(groups[1].quantity, 4);
  assert.equal(groups[2].quantity, 2);
});

test('complete period is grouped before pagination and does not read sales outside the selected input', () => {
  const input = Array.from({ length: 65 }, (_, index) => sale({ orderId: `order-${index}`, quantity: index + 1 }));
  const groups = context.groupMovementHistory(input);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].quantity, 2145);
  assert.equal(groups[0].saleCount, 65);
  const rendered = context.cashHistoryGroupedRows(groups.slice(0, 30), { search: '', columns: 5, grouped: true }).rows;
  assert.match(rendered, /2145 unidades vendidas/);
  assert.match(rendered, /65 vendas/);
  assert.match(rendered, /colspan="5"/);
});

test('search handles accents and product HTML is escaped in the expandable history', () => {
  const result = context.cashHistoryGroupedRows([sale({ description: '<Água>', quantity: 5 })], { search: 'agua' });
  assert.equal(result.groups.length, 1);
  assert.match(result.rows, /&lt;Água>/);
  assert.match(result.rows, /5 unidades vendidas/);
  assert.match(result.rows, /5× Balcão/);
  assert.equal(context.groupMovementHistory([]).length, 0);
});

test('PDF and Excel exports include grouped units and sales counts', () => {
  let report = '', spreadsheet = '';
  const exportContext = {
    ...context,
    overviewExportEntries: context.groupMovementHistory([sale(), sale({ orderId: 'second', quantity: 3, amount: 30 })]),
    overviewExportOperation: 'Adega', overviewExportLabel: 'Período selecionado',
    overviewExportName: format => `historico.${format}`,
    window: { open: () => ({ document: { write: html => { report = html; }, close() {} } }) },
    document: { createElement: () => ({ click() {} }) },
    Blob: class { constructor(parts) { spreadsheet = parts.join(''); } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    setTimeout() {},
  };
  const exportSource = source.slice(source.indexOf('function exportOverviewHistory('), source.indexOf('\nfunction menuPage()', source.indexOf('function exportOverviewHistory(')));
  runInNewContext(exportSource, exportContext);
  exportContext.exportOverviewHistory('pdf');
  assert.match(report, /<th>Unidades<\/th><th>Vendas<\/th>/);
  assert.match(report, /<td>5<\/td><td>2<\/td>/);
  assert.match(report, /colspan="6"/);
  exportContext.exportOverviewHistory('excel');
  assert.match(spreadsheet, /<th>Unidades vendidas<\/th><th>Vendas<\/th>/);
  assert.match(spreadsheet, /<td>5<\/td><td>2<\/td>/);
  assert.match(spreadsheet, /colspan="8"/);
});
