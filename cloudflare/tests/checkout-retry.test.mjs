import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createCheckoutRetry} from '../public/checkout-retry.js';

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

