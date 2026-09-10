import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';

test('checkout stock events deduct stock and cost without creating revenue or kitchen orders',async()=>{
  for(const event_type of ['loss','courtesy']){
    const f=fixture();f.sqlite.exec("UPDATE stock_balances SET quantity=10 WHERE id='beer'");
    const result=await f.call({action:'stock.event.create',event_type,items:[{menu_id:'beer',quantity:2}],responsible:'Caixa',beneficiary:event_type==='courtesy'?'Mesa 2':'',reason:event_type==='loss'?'Quebrou':'Cortesia'});
    assert.equal(result.status,200);assert.equal(f.balance('beer'),8);assert.equal(result.total_cost,6);
    assert.equal(f.records('sales').length,0);assert.equal(f.records('account_payments').length,0);assert.equal(f.records('kitchen').length,0);
    const event=f.records('stock_events')[0];assert.equal(event.event_type,event_type);assert.equal(event.cash_session_id,'cash');assert.equal(event.responsible,'Caixa');
    if(event_type==='courtesy')assert.equal(event.beneficiary,'Mesa 2');
    assert.equal(f.records('stock_movements')[0].type,event_type);
  }
});

test('failed loss or courtesy preserves cart stock and writes no partial event',async()=>{
  for(const event_type of ['loss','courtesy']){
    const f=fixture();
    const result=await f.call({action:'stock.event.create',event_type,items:[{menu_id:'beer',quantity:2}],responsible:'Caixa',reason:'Teste'});
    assert.equal(result.status,400);assert.match(result.error,/Estoque insuficiente/);assert.equal(f.balance('beer'),0);assert.equal(f.records('stock_events').length,0);assert.equal(f.records('stock_movements').length,0);
  }
});
