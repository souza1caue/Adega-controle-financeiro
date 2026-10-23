import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function summaryScreen({ sales = [], salesTotal = 0, stockEvents = {}, operating = 0, known = true } = {}) {
  const context = {
    data: { stock_events: stockEvents }, entries: Object.entries,
    cashLive: () => ({ sales, salesTotal, totalReceived: 999, expected: 999 }),
    dayOperatingCosts: () => ({ total: operating }),
    saleActualCost: sale => sale.cost,
    salesCostsAreKnown: () => known,
    money: value => `R$ ${value}`,
  };
  runInNewContext(source.slice(source.indexOf('function cashSummaryMetrics('), source.indexOf('function unifiedCashPage(')), context);
  return context;
}

test('summary subtracts products, employees, consumption, events, losses and courtesies without counting event products twice', () => {
  const context = summaryScreen({
    sales: [['direct', { cost: 50 }], ['tab', { cost: 30 }], ['event', { cost: 20, hosted_event_id: 'event' }]],
    salesTotal: 500,
    operating: 200 + 25 + 100 + 20,
    stockEvents: {
      loss: { cash_session_id: 'cash', event_type: 'loss', total_cost: 10 },
      courtesy: { cash_session_id: 'cash', event_type: 'courtesy', total_cost: 5 },
      consumption: { cash_session_id: 'cash', event_type: 'staff_consumption', total_cost: 25 },
      cancelled: { cash_session_id: 'cash', event_type: 'loss', total_cost: 999, cancelled_at: 'now' },
      other: { cash_session_id: 'previous', event_type: 'courtesy', total_cost: 999 },
    },
  });
  const result = context.cashSummaryMetrics('cash', {});
  assert.equal(result.sales, 500);
  assert.equal(result.cost, 440);
  assert.equal(result.profit, 60);
  const html = context.cashSummaryCards(result);
  assert.equal((html.match(/<article/g) || []).length, 3);
  assert.match(html, /<span>Vendas<\/span>/);
  assert.match(html, /<span>Custo<\/span>/);
  assert.match(html, /<span>Faturamento<\/span>/);
  assert.doesNotMatch(html, /Dinheiro em caixa|Recebimentos digitais|Total recebido/);
});

test('revenue stays available when product costs are missing or exceed sales', () => {
  const unknown = summaryScreen({ salesTotal: 100, known: false });
  const pending = unknown.cashSummaryCards(unknown.cashSummaryMetrics('cash', {}));
  assert.equal((pending.match(/<b>Pendente<\/b>/g) || []).length, 1);
  const loss = summaryScreen({ salesTotal: 50, operating: 80 });
  const result = loss.cashSummaryMetrics('cash', {});
  assert.equal(result.profit, -30);
  assert.doesNotMatch(loss.cashSummaryCards(result), /cash-profit-negative/);
  assert.match(loss.cashSummaryCards(result), /<span>Faturamento<\/span><b>R\$ 50<\/b>/);
});

test('empty cash summary starts at zero and does not treat supplies or old credit receipts as sales', () => {
  const context = summaryScreen();
  const result = context.cashSummaryMetrics('cash', { opening_amount: 100, movements: [{ type: 'supply', amount: 1000 }] });
  assert.equal(result.sales, 0);
  assert.equal(result.cost, 0);
  assert.equal(result.profit, 0);
});
