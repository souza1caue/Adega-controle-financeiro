import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const drawSource = source.slice(source.indexOf('function draw(){'), source.indexOf('\nfunction adminShell('));
const inputSource = source.slice(source.indexOf('document.addEventListener("input",'), source.indexOf('document.addEventListener("keydown",'));

function searchScreen() {
  let inputListener, pendingRender, renderedInput, focusCount = 0;
  const oldInput = {
    value: 'Cerveja', selectionStart: 3, selectionEnd: 5,
    matches: selector => selector === '[data-cash-history-search]',
  };
  const context = {
    disclosureState: { capture() {}, restore() {} },
    liveSync: { ensure() {} },
    page: 'cash', module: 'Admin', token: 'admin', refreshTimer: null,
    cashHistorySearch: '', cashHistoryOpen: false, cashReportsOpen: false, overviewPeriodOpen: false,
    document: { activeElement: oldInput, body: { classList: { toggle() {} } }, addEventListener: (_, callback) => { inputListener = callback; } },
    app: {
      classList: { toggle() {} },
      set innerHTML(value) {
        renderedInput = {
          value, selectionStart: 0, selectionEnd: 0,
          focus() { focusCount++; context.document.activeElement = this; },
          matches: oldInput.matches,
          setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
        };
        context.document.activeElement = null;
      },
      querySelector: selector => selector === '[data-cash-history-search]' ? renderedInput : null,
    },
    clearInterval() {}, setInterval() {}, startRefresh() {}, ensureVisibleHistory() {}, activeCash: () => null, setupNav() {},
    adminShell: value => value, fiadoLabels: value => value,
    unifiedCashPage: () => context.cashHistorySearch,
    scheduleSearchRender: (selector, render) => { pendingRender = { selector, render }; },
  };
  runInNewContext(drawSource + '\n' + inputSource, context);
  return { context, oldInput, input: options => inputListener({ target: oldInput, ...options }), rendered: () => renderedInput, pending: () => pendingRender, focusCount: () => focusCount };
}

test('automatic refresh retains unsubmitted history search text, focus, and cursor selection', () => {
  const screen = searchScreen();
  screen.input({ isComposing: false });
  assert.equal(screen.context.cashHistorySearch, 'Cerveja');
  assert.equal(screen.context.cashHistoryOpen, true);
  screen.context.draw();
  assert.equal(screen.rendered().value, 'Cerveja');
  assert.equal(screen.context.document.activeElement, screen.rendered());
  assert.equal(screen.rendered().selectionStart, 3);
  assert.equal(screen.rendered().selectionEnd, 5);
  screen.pending().render();
  assert.equal(screen.rendered().selectionStart, 3);
  assert.equal(screen.rendered().selectionEnd, 5);
});

test('clearing search by typing persists an empty filter through the next refresh', () => {
  const screen = searchScreen();
  screen.context.cashHistorySearch = 'Cerveja';
  screen.oldInput.value = '';
  screen.oldInput.selectionStart = screen.oldInput.selectionEnd = 0;
  screen.input({ isComposing: false });
  screen.context.draw();
  assert.equal(screen.rendered().value, '');
  assert.equal(screen.rendered().selectionStart, 0);
  assert.equal(screen.pending().selector, '[data-cash-history-search]');
});

test('composition saves the draft without scheduling a render and refresh does not steal focus', () => {
  const screen = searchScreen();
  screen.input({ isComposing: true });
  assert.equal(screen.context.cashHistorySearch, 'Cerveja');
  assert.equal(screen.pending(), undefined);
  screen.context.document.activeElement = { matches: () => false };
  screen.context.draw();
  assert.equal(screen.rendered().value, 'Cerveja');
  assert.equal(screen.focusCount(), 0);
});
