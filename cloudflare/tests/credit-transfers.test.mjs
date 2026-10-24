import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { fixture, worker } from './fixture.mjs';
import { historyPage, publicKinds } from '../src/state-sync.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const account=(f,id)=>f.records('accounts').find(a=>a.id===id);
async function tab(f,id='tab'){
 assert.equal((await f.call({action:'account.create',id,account_type:'tab',customer_name:'Patife'})).status,200);
 assert.equal((await f.call({action:'sale.checkout',destination:'tab',account_id:id,items:[{menu_id:'beer',quantity:5}]})).status,200);
}
const transfer=(f,extra={},headers)=>f.call({action:'account.convertToCredit',id:'tab',transfer_mode:'new',customer_name:'Patife',...extra},headers);

test('partial payment and transfer close the tab without recording more income or changing stock',async()=>{
 const f=fixture();try{
 await tab(f);const stock=f.balance('beer');
 assert.equal((await f.call({action:'account.receivePayment',id:'tab',amount:5,payment_method:'Digital'})).status,200);
 const result=await transfer(f);assert.equal(result.status,200);
 assert.equal(account(f,'tab').status,'closed');assert.equal(account(f,'tab').payments_total,40);
 assert.equal(account(f,result.id).items[0].price,35);
 const receipt=f.records('account_payments').find(p=>p.settlement_type==='transfer');
 assert.equal(receipt.cash_session_id,'cash');assert.equal(account(f,result.id).items[0].cash_session_id,'cash');
 assert.equal(f.balance('beer'),stock);assert.equal(f.records('sales').length,1);
 assert.equal((await f.call({action:'cash.close',id:'cash',counted_cash:0})).status,200);
 const cash=f.records('cash')[0];assert.equal(cash.total,5);assert.equal(cash.account_payments_count,1);
 assert.deepEqual(cash.payment_totals,{Digital:5});
 assert.equal((await f.call({action:'cash.open',id:'next',opening_amount:0})).status,200);
 assert.equal((await f.call({action:'account.receivePayment',id:result.id,amount:35,payment_method:'Digital'})).status,200);
 assert.equal(f.records('account_payments').filter(p=>p.cash_session_id==='next')[0].amount,35);
 assert.equal(f.records('cash').find(c=>c.id==='cash').total,5);
 }finally{f.sqlite.close()}
});

test('new mode ignores a stale existing customer selection; existing mode appends to the chosen credit',async()=>{
 for(const mode of ['new','existing']){const f=fixture();try{
 await tab(f);f.put('accounts','credit',{account_type:'customer',customer_name:'Other',opening_balance:12,items:[],payments_total:0,closed_at:'old'});
 const result=await transfer(f,{transfer_mode:mode,credit_account_id:'credit'});assert.equal(result.status,200);
 assert.equal(result.id==='credit',mode==='existing');
 assert.equal(account(f,result.id).items.length,1);
 if(mode==='existing'){assert.equal(account(f,'credit').opening_balance,12);assert.equal(account(f,'credit').closed_at,undefined)}
 else assert.equal(account(f,'credit').items.length,0);
 }finally{f.sqlite.close()}}
});

test('front station and shared QR can transfer tabs to credit',async()=>{
 for(const kind of ['device','qr']){const f=fixture();try{
 await tab(f);let headers;
 if(kind==='device'){f.put('device_access','front',{role:'front',token_hash:createHash('sha256').update('front-token').digest('hex')});headers={'x-device-access':'front-token'}}
 else {const shared=await f.call({action:'staff.access.shared'});const response=await worker.fetch(new Request('http://localhost/api/staff/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invite_token:shared.access_token})}),f.env);const claimed=await response.json();headers={'x-staff-access':claimed.access_token}}
 assert.equal((await transfer(f,{},headers)).status,200);
 }finally{f.sqlite.close()}}
});

test('repeated and concurrent transfer requests create exactly one debt and transfer record',async()=>{
 const f=fixture();try{
 await tab(f);
 const batch=f.env.DB.batch.bind(f.env.DB);let queue=Promise.resolve();
 f.env.DB.batch=statements=>{const next=queue.then(()=>batch(statements));queue=next.catch(()=>{});return next};
 const results=await Promise.all([transfer(f),transfer(f)]);assert.ok(results.every(r=>r.status===200));
 assert.equal(results[0].id,results[1].id);assert.equal((await transfer(f)).id,results[0].id);
 assert.equal(f.records('account_payments').length,1);
 assert.equal(f.records('accounts').length,2);
 assert.equal(account(f,results[0].id).items.length,1);
 }finally{f.sqlite.close()}
});

test('simultaneous transfers from different tabs preserve both items in an existing credit',async()=>{
 const f=fixture();try{
 await tab(f);await tab(f,'tab2');f.put('accounts','credit',{account_type:'customer',customer_name:'Patife',items:[],payments_total:0});
 const batch=f.env.DB.batch.bind(f.env.DB);let queue=Promise.resolve();f.env.DB.batch=s=>{const next=queue.then(()=>batch(s));queue=next.catch(()=>{});return next};
 const results=await Promise.all([transfer(f,{transfer_mode:'existing',credit_account_id:'credit'}),transfer(f,{id:'tab2',transfer_mode:'existing',credit_account_id:'credit'})]);
 assert.ok(results.every(r=>r.status===200));assert.equal(account(f,'credit').items.length,2);assert.equal(f.records('account_payments').length,2);
 }finally{f.sqlite.close()}
});

test('invalid destinations and tabs from another cash fail without partial writes',async()=>{
 for(const extra of [{transfer_mode:'existing',credit_account_id:''},{transfer_mode:'existing',credit_account_id:'missing'},{transfer_mode:'invalid'}]){
 const f=fixture();try{await tab(f);const result=await transfer(f,extra);assert.equal(result.status,400);assert.equal(account(f,'tab').status,'open');assert.equal(f.records('account_payments').length,0)}finally{f.sqlite.close()}}
 const f=fixture();try{await tab(f);f.put('accounts','tab',{...account(f,'tab'),cash_session_id:'other'});assert.equal((await transfer(f)).status,400)}finally{f.sqlite.close()}
});

test('legacy transfer is repaired to its original cash and never becomes a receipt on the next day',()=>{
 const f=fixture();try{
 f.put('cash','cash',{status:'closed',opened_at:'2026-10-23T22:13:00.000Z',closed_at:'2026-10-24T14:27:00.000Z'});
 f.put('accounts','tab',{account_type:'tab',cash_session_id:'cash'});
 f.put('account_payments','transfer',{account_id:'tab',settlement_type:'transfer',payment_method:'Transferido para fiado',amount:35,created_at:'2026-10-24T05:16:18.513Z'});
 f.sqlite.exec(readFileSync(new URL('../migrations/0007_transfer_cash_session.sql',import.meta.url),'utf8'));
 const payment=f.records('account_payments')[0];assert.equal(payment.cash_session_id,'cash');
 const ctx={entries:Object.entries,money:value=>'R$ '+value,data:{accounts:{},account_payments:{transfer:payment}},summaryCalendarMonth:'2026-10',cashProject:()=>'',date:String};
 const functions=['isMoneyReceipt','cashAccountPayments','transferHistoryEntries','localDay'].map(name=>source.split('\n').find(l=>l.startsWith('function '+name+'('))).join('\n');
 runInNewContext(functions+'\n'+source.slice(source.indexOf('function periodSelection('),source.indexOf('function groupedOrders(')),ctx);
 assert.equal(ctx.isMoneyReceipt(payment),false);assert.equal(ctx.cashAccountPayments('cash').length,0);
 const history=ctx.transferHistoryEntries(new Set(['cash']));assert.equal(history.length,1);assert.equal(history[0].amount,0);assert.match(history[0].detail,/35/);assert.equal(ctx.transferHistoryEntries(new Set(['next'])).length,0);
 const options=[['cash',f.records('cash')[0]]];
 assert.equal(ctx.periodSelection([],options,'day:2026-10-23').periodCashIds.has('cash'),true);
 assert.equal(ctx.periodSelection([],options,'day:2026-10-24').periodCashIds.size,0);
 options.push(['next',{opened_at:'2026-10-24T22:00:00.000Z',status:'open'}]);
 assert.deepEqual([...ctx.periodSelection([],options,'day:2026-10-24').periodCashIds],['next']);
 }finally{f.sqlite.close()}
});

test('switching transfer modes disables hidden fields so the wrong destination cannot be submitted',()=>{
 const form={elements:{transfer_mode:{value:'new'},credit_account_id:{value:'old'},customer_name:{}},querySelector:()=>({})};
 const ctx={};runInNewContext(source.split('\n').find(l=>l.startsWith('function updateTabConvertFields(')),ctx);
 ctx.updateTabConvertFields(form);assert.equal(form.elements.credit_account_id.disabled,true);assert.equal(form.elements.customer_name.disabled,false);
 form.elements.transfer_mode.value='existing';ctx.updateTabConvertFields(form);assert.equal(form.elements.credit_account_id.disabled,false);assert.equal(form.elements.customer_name.disabled,true);
});

test('manual consumptions remain linked to the current cash after midnight',async()=>{
 const f=fixture();try{await tab(f);assert.equal((await f.call({action:'account.addItem',id:'tab',description:'Extra',quantity:1,price:3})).status,200);const sale=f.records('sales').find(s=>s.description==='Extra');assert.equal(sale.cash_session_id,'cash');assert.equal(account(f,'tab').items.at(-1).cash_session_id,'cash')}finally{f.sqlite.close()}
});

test('history API follows the cash opening day for transfers made after midnight',async()=>{
 const f=fixture();try{
 f.put('cash','cash',{status:'closed',opened_at:'2026-10-23T22:13:00.000Z',closed_at:'2026-10-24T14:27:00.000Z'});
 f.put('account_payments','transfer',{cash_session_id:'cash',settlement_type:'transfer',amount:35,created_at:'2026-10-24T05:16:00.000Z'});
 const day23=await historyPage(f.env.DB,new URLSearchParams({kind:'account_payments',from:'2026-10-23T03:00:00.000Z',to:'2026-10-24T02:59:59.999Z'}),publicKinds);
 const day24=await historyPage(f.env.DB,new URLSearchParams({kind:'account_payments',from:'2026-10-24T03:00:00.000Z',to:'2026-10-25T02:59:59.999Z'}),publicKinds);
 assert.deepEqual(Object.keys(day23.records),['transfer']);assert.deepEqual(Object.keys(day24.records),[]);
 }finally{f.sqlite.close()}
});
