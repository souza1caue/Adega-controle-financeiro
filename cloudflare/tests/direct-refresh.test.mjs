import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {fixture,worker} from './fixture.mjs';
import {historyPage,allowedKinds} from '../src/state-sync.js';
import {closingSummary} from '../src/cash-summary.js';
const admin=allowedKinds(true,false),params=value=>new URLSearchParams(value);
const sale=(cash='cash',created_at=new Date().toISOString(),extra={})=>({menu_id:'beer',cash_session_id:cash,description:'Beer',quantity:1,price:8,unit_cost:3,created_at,...extra});

test('state always returns complete records and balances, without revision journal work',async()=>{
 const f=fixture();
 try{
  f.put('cash','archive',{status:'closed',opened_at:'2020-01-01'});
  f.put('sales','old',sale('archive','2020-01-01T12:00:00.000Z'));
  f.put('sales','current',sale());
  const queries=[],prepare=f.env.DB.prepare;f.env.DB.prepare=sql=>{queries.push(sql);return prepare(sql)};
  const response=await worker.fetch(new Request('http://localhost/api/state?since=999999',{headers:{authorization:'Bearer test-token'}}),f.env);
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.sync,undefined);assert.deepEqual(Object.keys(body.sales).sort(),['current','old']);
  assert.equal(body.stock_items.beer.stock_quantity,0);
  assert.ok(queries.some(sql=>sql==='SELECT kind,id,data FROM records ORDER BY created_at'));
  assert.ok(queries.every(sql=>!sql.includes('record_changes')));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM record_changes').get().n,0);
 }finally{f.sqlite.close()}
});

test('cash-period history includes after-midnight sales and legacy dates, with stable pagination',async()=>{
  const f=fixture();
  f.put('cash','night',{status:'closed',opened_at:'2025-06-10T21:00:00.000Z',closed_at:'2025-06-11T05:00:00.000Z'});
  f.put('sales','night-1',sale('night','2025-06-11T03:00:00.000Z'));
  f.put('sales','night-2',sale('night','2025-06-11T03:00:00.000Z'));
  f.put('sales','legacy',sale('', '2025-06-10T22:00:00.000Z'));
  f.put('sales','other',sale('cash','2025-06-10T22:00:00.000Z'));
  const query={kind:'sales',from:'2025-06-10T03:00:00.000Z',to:'2025-06-11T02:59:59.999Z',limit:'1'},ids=[];
  let next=null;
  do{const page=await historyPage(f.env.DB,params({...query,...(next?{before:next}:{})}),admin);ids.push(...Object.keys(page.records));next=page.next}while(next);
  assert.deepEqual(ids,['night-2','night-1','legacy']);
  const cashOnly=await historyPage(f.env.DB,params({kind:'sales',cash_id:'night'}),admin);assert.equal(Object.keys(cashOnly.records).length,2);
  const accountQuery=await historyPage(f.env.DB,params({kind:'account_payments',account_id:'a'}),admin);assert.deepEqual(accountQuery.records,{});
  await assert.rejects(historyPage(f.env.DB,params({kind:'staff_access'}),admin));
  await assert.rejects(historyPage(f.env.DB,params({kind:'sales',before:'bad'}),admin));
  await assert.rejects(historyPage(f.env.DB,params({kind:'sales',from:'bad',to:'bad'}),admin));
});

test('history and live API enforce authorization before querying data and do not expose credentials',async()=>{
  const f=fixture();
  f.put('device_access','kitchen',{role:'kitchen',token_hash:createHash('sha256').update('kitchen-token').digest('hex')});
  for(const route of ['/api/state','/api/history?kind=sales'])assert.equal((await worker.fetch(new Request(`http://localhost${route}`),f.env)).status,401);
  const forbidden=await worker.fetch(new Request('http://localhost/api/history?kind=sales',{headers:{'x-device-access':'kitchen-token'}}),f.env);assert.equal(forbidden.status,400);
  const response=await worker.fetch(new Request('http://localhost/api/state',{headers:{authorization:'Bearer test-token'}}),f.env);
  assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.json();
  assert.equal(body.device_access.kitchen.token_hash,undefined);
  f.sqlite.prepare("DELETE FROM sessions").run();
  assert.equal((await worker.fetch(new Request(`http://localhost/api/state?since=${0}`,{headers:{authorization:'Bearer test-token'}}),f.env)).status,401);
});

test('closing saves a frozen sales, cost and profit summary without removing audit records',async()=>{
  const f=fixture();
  assert.equal((await f.call({action:'sale.checkout',destination:'sale',payment_method:'Digital',items:[{menu_id:'beer',quantity:2}]})).status,200);
  assert.equal((await f.call({action:'cash.close',id:'cash',closed_by:'Test',counted_cash:0})).status,200);
  assert.deepEqual(f.records('cash')[0].closing_summary,{version:1,sales:16,cost:6,profit:10,known:true,product_cost:6,operating_cost:0,loss_courtesy_cost:0});
  assert.equal(f.records('sales').length,1);
});

test('closing summary counts staff, events and waste once, keeping missing costs pending',async()=>{
  const f=fixture();
  f.put('staff_shifts','staff',{cash_session_id:'cash',daily_rate:100,status:'confirmed'});
  f.put('staff_shifts','fee',{cash_session_id:'cash',daily_rate:50,status:'confirmed',group:'Evento'});
  f.put('hosted_events','event',{cash_session_id:'cash',simple_event:true,event_mode:'contracted',fee_shift_id:'fee',fee_amount:50,consumption_mode:'fixed',fixed_consumption:20});
  f.put('stock_events','food',{cash_session_id:'cash',event_type:'staff_consumption',total_cost:10});
  f.put('stock_events','loss',{cash_session_id:'cash',event_type:'loss',total_cost:5});
  f.put('stock_events','cancelled',{cash_session_id:'cash',event_type:'loss',total_cost:999,cancelled_at:'now'});
  const result=await closingSummary(f.env.DB,'cash',[sale('cash',undefined,{price:200,unit_cost:30})]);
  assert.equal(result.cost,215);assert.equal(result.profit,-15);assert.equal(result.known,true);
  assert.equal((await closingSummary(f.env.DB,'cash',[sale('cash',undefined,{unit_cost:0})])).known,false);
});

test('all screens refresh directly every three seconds without waiting for a previous request',async()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');let tick,interval,loads=0;
 const context={token:'admin',deviceToken:'',originToken:'',setInterval:(callback,ms)=>{tick=callback;interval=ms},load:()=>{loads++;return new Promise(()=>{})},showSyncError:assert.fail};
 runInNewContext(source.split('\n').find(line=>line.startsWith('function startRefresh('))+'\nstartRefresh(true);',context);
 assert.equal(interval,3000);tick();tick();assert.equal(loads,2);
 assert.doesNotMatch(source,/createLiveSync|createOperationAccessCache|moduleStateCache|loadHistory\(/);
});
