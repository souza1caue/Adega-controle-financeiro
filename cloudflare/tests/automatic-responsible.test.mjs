import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';

test('cash operations keep audit records without manually supplied names', async () => {
  const f = fixture();
  f.sqlite.exec("DELETE FROM records WHERE kind='cash'");
  assert.equal((await f.call({action:'cash.open',id:'new',opening_amount:20})).status,200);
  assert.equal((await f.call({action:'cash.movement',id:'new',type:'supply',amount:5,note:'Troco'})).status,200);
  assert.equal((await f.call({action:'cash.close',id:'new',counted_cash:25})).status,200);
  const cash=f.records('cash')[0];
  assert.equal(cash.opened_by,'Caixa principal');
  assert.equal(cash.closed_by,'Caixa principal');
  assert.equal(cash.movements[0].responsible,'Caixa principal');
  assert.equal(cash.difference,0);
});

test('loss and cancellation work without names and still require a cancellation reason', async () => {
  const f=fixture();
  f.sqlite.exec("UPDATE stock_balances SET quantity=10 WHERE id='beer'");
  const result=await f.call({action:'stock.event.create',event_type:'loss',items:[{menu_id:'beer',quantity:2}],reason:'Quebrou'});
  assert.equal(result.status,200);
  const event=f.records('stock_events')[0];
  assert.equal(event.responsible,'Caixa principal');
  assert.equal(f.balance('beer'),8);
  assert.equal((await f.call({action:'stock.event.cancel',id:event.id})).status,400);
  assert.equal(f.balance('beer'),8);
  assert.equal((await f.call({action:'stock.event.cancel',id:event.id,reason:'Registro duplicado'})).status,200);
  assert.equal(f.balance('beer'),10);
  assert.equal(f.records('stock_events')[0].cancelled_by,'Caixa principal');
});

test('credit payments accept an omitted or blank responsible', async () => {
  for (const responsible of [undefined,'   ']) {
    const f=fixture();
    f.put('accounts','credit',{customer_name:'Cliente',account_type:'customer',opening_balance:10,items:[],payments_total:0});
    const result=await f.call({action:'account.receivePayment',id:'credit',amount:10,payment_method:'Dinheiro',responsible});
    assert.equal(result.status,200);
    assert.equal(f.records('account_payments')[0].responsible,'Caixa principal');
  }
});
