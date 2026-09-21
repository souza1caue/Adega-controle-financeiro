import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { tapLink, tapReturn } from '../public/tap-link.mjs';

const prepare = (id='tap-order') => ({ action:'tap.prepare', id, handle:'adega_test', card_method:'debit', items:[{menu_id:'beer',quantity:2}] });
const confirm = (id='tap-order') => ({action:'tap.confirm',id,confirmed_received:true,nsu:'receipt-123456',aut:'ABC123'});

test('Tap prepares server-priced pending order without sale or stock change, and retries reuse it', async () => {
  const f = fixture();
  const request = {...prepare(),total_cents:1};
  const result = await f.call(request);
  assert.equal(result.status,200); assert.equal(result.payment.total_cents,1600);
  assert.equal(f.records('sales').length,0); assert.equal(f.balance('beer'),0);
  assert.equal((await f.call(request)).status,200); assert.equal(f.records('tap_payments').length,1);
  assert.equal((await f.call({...prepare('tiny'),items:[{menu_id:'beer',quantity:0}]})).status,400);
  assert.equal((await f.call({...prepare('bad'),card_method:'pix'})).status,400);
});

test('Tap requires operator verification; persists original price, records once and rejects reused receipt', async () => {
  const f = fixture(); await f.call(prepare());
  assert.equal((await f.call({...confirm(),confirmed_received:false})).status,400);
  assert.equal(f.records('sales').length,0);
  f.put('menu','beer',{name:'Cerveja',price:99,category:'Bebidas'});
  assert.equal((await f.call({...confirm(),items:[],total_cents:1})).status,200);
  assert.equal(f.records('sales')[0].price,8); assert.equal(f.balance('beer'),-2);
  assert.equal(f.records('tap_payments')[0].verification,'operator_confirmed');
  assert.equal((await f.call(confirm())).already_recorded,true);
  assert.equal(f.records('sales').length,1); assert.equal(f.balance('beer'),-2);
  await f.call(prepare('other'));
  assert.equal((await f.call(confirm('other'))).status,400);
});

test('Tap rejects unauthorized access and payments after discard or cash change', async () => {
  const f = fixture();
  assert.equal((await f.call(prepare(),{})).status,401);
  assert.equal((await f.call({action:'tap.list'},{})).status,401);
  await f.call(prepare());
  assert.equal((await f.call({action:'tap.cancel',id:'tap-order'})).status,400);
  assert.equal((await f.call({action:'tap.cancel',id:'tap-order',confirmed_unpaid:true})).status,200);
  assert.equal((await f.call(confirm())).status,400);
  await f.call(prepare('new'));
  f.put('cash','cash',{status:'closed'}); f.put('cash','second',{status:'open'});
  assert.equal((await f.call(confirm('new'))).status,400);
  assert.equal(f.records('sales').length,0);
});

test('Tap transaction rolls back sale and confirmation if stock mutation fails', async () => {
  const f = fixture(); await f.call(prepare());
  f.sqlite.exec("CREATE TRIGGER test_failure BEFORE INSERT ON records WHEN NEW.kind='stock_movements' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.equal((await f.call(confirm())).status,400);
  assert.equal(f.records('sales').length,0); assert.equal(f.records('tap_finalized').length,0);
  assert.equal(f.records('tap_payments')[0].status,'pending'); assert.equal(f.balance('beer'),0);
});

test('Cash cannot close while a Tap payment needs reconciliation', async () => {
  const f = fixture(); await f.call(prepare());
  const result = await f.call({action:'cash.close',id:'cash',counted_cash:0,counted_account:0});
  assert.equal(result.status,400); assert.match(result.error,/InfiniteTap pendentes/);
  assert.equal(f.records('cash')[0].status,'open');
});

test('Tap legacy stock uses current balance without overwriting newer menu changes', async () => {
  const f = fixture();
  f.put('menu','legacy',{name:'Antigo',price:10,stock_controlled:true,stock_quantity:20});
  await f.call({...prepare(),items:[{menu_id:'legacy',quantity:2}]});
  f.put('menu','legacy',{name:'Atualizado',price:15,stock_controlled:true,stock_quantity:30});
  assert.equal((await f.call(confirm())).status,200);
  const item = f.records('menu').find(i=>i.id==='legacy');
  assert.equal(item.stock_quantity,28); assert.equal(item.name,'Atualizado'); assert.equal(item.price,15);
  assert.equal(f.records('sales')[0].price,10);
});

test('Tap links carry cents, merchant, order identity and encoded HTTPS return; callback is not proof', () => {
  const url = new URL(tapLink({id:'order-123',status:'pending',total_cents:1600,card_method:'debit',handle:'adega_test'},'https://example.com'));
  assert.equal(url.protocol,'infinitepaydash:'); assert.equal(url.searchParams.get('amount'),'1600');
  assert.equal(url.searchParams.get('handle'),'adega_test');
  assert.equal(url.searchParams.get('result_url'),'https://example.com/tap-test.html?tap_order=order-123');
  assert.throws(() => tapLink({status:'recorded'},'https://example.com'));
  assert.ok(tapReturn('?tap_order=a&order_id=b').error);
  assert.ok(tapReturn('?tap_order=a&order_id=a&warning=failed').error);
  const result = tapReturn('?tap_order=a&order_id=a&nsu=123&aut=456');
  assert.deepEqual(result,{id:'a',nsu:'123',aut:'456'}); assert.equal(result.approved,undefined);
});
