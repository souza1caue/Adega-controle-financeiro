import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createLiveSync, createCheckoutRetry } from '../public/live-sync.js';

function harness() {
  let clock = 100000, visible = true, owner = 'front', fail = false, reads = 0, tickets = 0, next = 0;
  const timers = new Map(), sockets = [], states = [];
  class Socket {
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.closed = true; this.onclose?.(); }
    open() { this.onopen(); }
    signal() { this.onmessage({ data: 'changed' }); }
  }
  const live = createLiveSync({
    headers: () => ({ authorization: owner }), identity: () => owner, active: () => visible,
    refresh: async () => { reads++; }, status: value => states.push(value), url: 'https://adega.test',
    request: async () => { tickets++; return { ok: !fail, json: async () => ({ ticket: 'signed-ticket' }) }; },
    Socket, later: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, cancel: id => timers.delete(id), now: () => clock, random: () => 0,
  });
  function run(ms) { const match = [...timers].find(([, timer]) => timer.ms === ms); assert.ok(match, `timer ${ms}`); timers.delete(match[0]); match[1].fn(); }
  return { live, sockets, timers, states, run, reads: () => reads, tickets: () => tickets,
    advance: ms => clock += ms, hide: () => visible = false, owner: value => owner = value, fail: () => fail = true };
}

test('live signals coalesce updates, safety polling stays on, and disconnect restores fast polling', async () => {
  const h = harness(); await h.live.ensure(); h.sockets[0].open();
  assert.equal(h.live.connected, true); assert.match(h.sockets[0].url, /^wss:/);
  h.run(80); assert.equal(h.reads(), 1);
  h.live.synced(); assert.equal(h.live.shouldPoll(), false);
  h.sockets[0].signal(); h.sockets[0].signal(); h.sockets[0].signal(); h.run(80);
  assert.equal(h.reads(), 2);
  h.advance(60000); assert.equal(h.live.shouldPoll(), true);
  h.live.synced(); h.sockets[0].close(); assert.equal(h.live.shouldPoll(), true);
  h.run(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sockets.length, 2);
  h.hide(); h.live.stop(); assert.equal(h.timers.size, 0);
  await h.live.ensure(); assert.equal(h.tickets(), 2);
});

test('connection renewal reauthorizes, and switching identity closes the old connection', async () => {
  const h = harness(); await h.live.ensure(); h.sockets[0].open(); h.run(80); h.run(240000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sockets[0].closed, true); assert.equal(h.tickets(), 2);
  h.sockets[1].open(); h.owner('kitchen'); await h.live.ensure();
  assert.equal(h.sockets[1].closed, true); assert.equal(h.tickets(), 3);
  h.live.stop();
});

test('unavailable live service retains periodic reads and backs off reconnection attempts', async () => {
  const h = harness(); h.fail(); await h.live.ensure();
  assert.equal(h.live.shouldPoll(), true); h.run(1000);
  await new Promise(resolve => setImmediate(resolve)); h.run(2000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.tickets(), 3); h.live.stop(); assert.equal(h.timers.size, 0);
});

test('checkout retry keys survive reload, isolate operator identities, and reset after confirmed success', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  let serial = 0; const uuid = () => `request-${++serial}`, payload = { action: 'sale.checkout', items: [{ menu_id: 'food', quantity: 2 }] };
  let retry = createCheckoutRetry(storage, uuid);
  const first = retry.begin('front', payload); assert.equal(retry.begin('front', payload).request_id, first.request_id);
  retry = createCheckoutRetry(storage, uuid); assert.equal(retry.begin('front', payload).request_id, first.request_id);
  assert.notEqual(retry.begin('other', payload).request_id, first.request_id);
  retry.complete('front', payload); assert.notEqual(retry.begin('front', payload).request_id, first.request_id);
});

test('a saved checkout is successful even if the following screen refresh fails', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const messages = [], errors = [], payload = { action: 'sale.checkout' };
  const context = {
    module: 'Admin', token: 'admin', deviceToken: '', originToken: '', frontIdentityToken: '', data: {},
    authIdentity: () => 'admin', checkoutRetry: { begin: (_, value) => value, complete() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, id: 'saved-order' }) }),
    load: async () => { throw new Error('network lost'); }, toast: message => messages.push(message), showSyncError: error => errors.push(error),
  };
  runInNewContext(source.slice(source.indexOf('async function mutate('), source.indexOf('function toast(')), context);
  assert.equal((await context.mutate(payload)).id, 'saved-order');
  assert.equal(errors.length, 1); assert.match(messages[0], /salvo/i);
});

test('only a visible kitchen screen acknowledges orders, with bounded batches and no overlapping acknowledgement', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  let kitchen = false, requests = 0, release, refreshes = 0;
  const context = {
    document: { hidden: false }, kitchenViewOpen: () => kitchen,
    data: { kitchen: Object.fromEntries(Array.from({ length: 90 }, (_, id) => [String(id), { status: 'pending' }])) },
    entries: Object.entries, syncHeaders: () => ({ 'x-device-access': 'test' }), showSyncError: assert.fail,
    load: async () => { refreshes++; },
    fetch: async (_, options) => {
      requests++; const payload = JSON.parse(options.body);
      assert.equal(payload.action, 'kitchen.received'); assert.equal(payload.ids.length, 80);
      return new Promise(resolve => { release = () => resolve({ ok: true }); });
    },
  };
  runInNewContext(source.slice(source.indexOf('let kitchenAcknowledging=false;'), source.indexOf('function kitchenReceipt(')), context);
  await context.acknowledgeKitchen(); assert.equal(requests, 0);
  kitchen = true; context.document.hidden = true;
  await context.acknowledgeKitchen(); assert.equal(requests, 0);
  context.document.hidden = false;
  const pending = context.acknowledgeKitchen(); await context.acknowledgeKitchen(); assert.equal(requests, 1);
  release(); await pending; assert.equal(refreshes, 1);
});
