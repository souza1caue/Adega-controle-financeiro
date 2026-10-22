import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture } from './fixture.mjs';

async function ready() {
  const f = fixture();
  f.sqlite.exec("UPDATE stock_balances SET quantity=20 WHERE id='beer'");
  f.put('device_access', 'front', { role: 'front', label: 'Caixa', token_hash: createHash('sha256').update('front-token').digest('hex') });
  f.front = { 'x-device-access': 'front-token' };
  assert.equal((await f.call({action:'account.create',id:'tab',account_type:'tab',customer_name:'Mesa 1'},f.front)).status,200);
  assert.equal((await f.call({action:'sale.checkout',destination:'tab',account_id:'tab',items:[{menu_id:'beer',quantity:2}]},f.front)).status,200);
  f.convert = (extra={}) => f.call({action:'account.itemToEvent',id:'tab',item_id:f.records('accounts')[0].items[0].id,event_type:'loss',reason:'Quebrou',...extra},f.front);
  return f;
}
for (const event_type of ['loss','courtesy']) test(`tab item becomes ${event_type} without another stock deduction`, async () => {
  const f=await ready();
  assert.equal((await f.convert({event_type})).status,200);
  assert.equal(f.balance('beer'),18);
  assert.ok(f.records('sales')[0].voided_at);
  const event=f.records('stock_events')[0],item=f.records('accounts')[0].items[0];
  assert.equal(event.event_type,event_type);
  assert.equal(event.total_cost,6);
  assert.equal(event.revenue_not_realized,16);
  assert.equal(event.items[0].stock_usage[0].quantity,2);
  assert.equal(event.cash_session_id,'cash');
  assert.equal(item.stock_event_id,event.id);
  assert.ok(item.cancelled_at);
  assert.notEqual((await f.convert()).status,200);
  assert.equal(f.records('stock_events').length,1);
  assert.notEqual((await f.call({action:'account.receivePayment',id:'tab',amount:16,payment_method:'Dinheiro'},f.front)).status,200);
});
test('rejects invalid, paid and closed tab conversions without changing stock or records',async()=>{
  for(const mode of ['invalid','paid','closed','other-cash','hosted','reason']){
    const f=await ready(),tab=f.records('accounts')[0];
    if(mode==='paid')tab.payments_total=8;
    if(mode==='closed')tab.status='closed';
    if(mode==='other-cash')tab.cash_session_id='old';
    if(mode==='hosted')tab.hosted_event_id='event';
    f.put('accounts','tab',tab);
    const result=await f.convert(mode==='invalid'?{event_type:'invalid'}:mode==='reason'?{reason:''}:{});
    assert.notEqual(result.status,200,mode);
    assert.equal(f.records('stock_events').length,0);
    assert.equal(f.balance('beer'),18);
    assert.ok(!f.records('sales')[0].voided_at);
  }
});
