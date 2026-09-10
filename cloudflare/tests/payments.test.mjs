import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixture } from './fixture.mjs';
const sale=(id,method)=>({action:'sale.checkout',id,items:[{menu_id:'beer',quantity:1}],payment_method:method});

test('checkout accepts physical and digital payments without a card subtype',async()=>{
  for(const [method,expected] of [['Dinheiro','Dinheiro'],['Digital','Digital'],['Pix','Digital'],['Cart\u00e3o','Digital']]){
    const f=fixture();assert.equal((await f.call(sale('order',method))).status,200);
    assert.equal(f.records('sales')[0].payment_method,expected);assert.equal(f.records('sales')[0].card_type,'');
  }
  const f=fixture();assert.equal((await f.call(sale('invalid','Other'))).status,400);assert.equal(f.records('sales').length,0);
});

test('tab and credit receipts accept digital payment and reconcile both opening balances',async()=>{
  const f=fixture();f.put('cash','cash',{status:'open',opened_at:new Date().toISOString(),opening_amount:50,opening_account_amount:100});
  for(const type of ['tab','customer']){
    f.put('accounts',type,{customer_name:type,account_type:type,cash_session_id:'cash',status:'open',opening_balance:0,items:[{id:'item',description:'Beer',quantity:1,price:8}],payments_total:0});
    assert.equal((await f.call({action:'account.receivePayment',id:type,amount:8,payment_method:'Digital',responsible:'Teste'})).status,200);
  }
  assert.equal((await f.call(sale('physical','Dinheiro'))).status,200);
  assert.equal((await f.call(sale('digital','Digital'))).status,200);
  // Existing records remain intact and are grouped only for totals.
  for(const [index,method] of ['Pix','Cart\u00e3o - D\u00e9bito','Cart\u00e3o - Cr\u00e9dito'].entries())f.put('sales',`old-${index}`,{description:'Old',quantity:1,price:10,payment_method:method,cash_session_id:'cash',created_at:new Date().toISOString()});
  assert.equal((await f.call({action:'cash.close',id:'cash',closed_by:'Teste',counted_cash:58,counted_account:154})).status,200);
  const cash=f.records('cash')[0];assert.deepEqual(cash.payment_totals,{Dinheiro:8,Digital:54});assert.equal(cash.expected_cash,58);assert.equal(cash.expected_account,154);assert.equal(cash.difference,0);assert.equal(cash.account_difference,0);
  assert.equal(f.records('sales').find(s=>s.id==='old-0').payment_method,'Pix');
});

test('live cashier totals group old and new digital methods without mixing physical cash',()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const group=source.slice(0,source.indexOf('\n}',source.indexOf('function paymentGroup'))+2);
  const cashFunction=source.split('\n').find(line=>line.startsWith('function cashLive('));
  const sales=['Dinheiro','Digital','Pix','Cart\u00e3o - D\u00e9bito'].map((payment_method,i)=>[String(i),{payment_method,quantity:1,price:10}]);
  const result=runInNewContext(group+'\n'+cashFunction+'\ncashLive("cash",{opening_amount:50})',{cashSales:()=>sales,cashAccountPayments:()=>[['receipt',{payment_method:'Digital',amount:5}]],data:{menu:{},staff_shifts:{}},entries:Object.entries});
  assert.equal(result.expected,60);assert.equal(result.payments.Dinheiro,10);assert.equal(result.payments.Digital,35);assert.equal(Object.keys(result.payments).length,2);
});
