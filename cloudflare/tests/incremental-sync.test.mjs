import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { fixture, worker } from './fixture.mjs';
import { syncState, historyPage, allowedKinds } from '../src/state-sync.js';
import { closingSummary } from '../src/cash-summary.js';
import { mergeState, mergeRecords, refreshDelay } from '../public/data-sync.js';
const admin = allowedKinds(true,false);
const params = value => new URLSearchParams(value);
const snapshot = f => syncState(f.env.DB,params({}),admin);
const delta = (f,cursor) => syncState(f.env.DB,params({since:String(cursor)}),admin);
const sale = (cash='cash',created_at=new Date().toISOString(),extra={})=>({menu_id:'beer',cash_session_id:cash,description:'Beer',quantity:1,price:8,unit_cost:3,created_at,...extra});

 test('initial operation excludes archived transactions; idle sync only queries the indexed change journal',async()=>{
  const f=fixture();
  f.put('cash','old',{status:'closed',opened_at:'2024-01-01T15:00:00.000Z',closed_at:'2024-01-02T01:00:00.000Z'});
  f.sqlite.exec('BEGIN');
  for(let i=0;i<2000;i++)f.put('sales',`old-${i}`,sale('old','2024-01-01T20:00:00.000Z'));
  f.sqlite.exec('COMMIT');
  f.put('sales','current',sale());
  const first=await snapshot(f);
  assert.deepEqual(Object.keys(first.sales),['current']);
  assert.equal(first.cash.old.status,'closed'); // Archive totals remain available.
  const queries=[],original=f.env.DB.prepare;
  f.env.DB.prepare=sql=>{queries.push(sql);return original(sql)};
  const idle=await delta(f,first.sync.cursor);
  assert.equal(idle.sync.incremental,true);assert.deepEqual(idle.sales,{});assert.deepEqual(idle.stock_items,{});
  assert.equal(queries.length,2);assert.match(queries[1],/WHERE c.seq>\?/);
  const plan=f.sqlite.prepare('EXPLAIN QUERY PLAN SELECT * FROM record_changes WHERE seq>? AND seq<=? ORDER BY seq LIMIT 501').all(first.sync.cursor,first.sync.cursor);
  assert.ok(plan.some(row=>/INTEGER PRIMARY KEY/.test(row.detail)));
  assert.equal((await delta(f,first.sync.cursor)).sync.cursor,first.sync.cursor);
});

test('two devices receive immediate sales, stock balances, cancellations and deletion tombstones',async()=>{
  const f=fixture(),knownA=new Map(),knownB=new Map();
  let a=mergeState({},await snapshot(f),knownA),b=mergeState({},await snapshot(f),knownB);
  const checkout=await f.call({action:'sale.checkout',destination:'sale',payment_method:'Digital',items:[{menu_id:'beer',quantity:2}]});
  assert.equal(checkout.status,200);
  a=mergeState(a,await delta(f,a.sync.cursor),knownA);b=mergeState(b,await delta(f,b.sync.cursor),knownB);
  assert.equal(Object.keys(a.sales).length,1);assert.deepEqual(a.sales,b.sales);assert.equal(b.stock_items.beer.stock_quantity,-2);
  assert.equal((await f.call({action:'sale.order.void',order_id:checkout.id,reason:'Test cancellation'})).status,200);
  b=mergeState(b,await delta(f,b.sync.cursor),knownB);
  assert.ok(Object.values(b.sales)[0].voided_at);assert.equal(b.stock_items.beer.stock_quantity,0);
  assert.equal((await f.call({action:'menu.delete',id:'beer'})).status,200);
  const removal=await delta(f,b.sync.cursor);
  assert.ok(removal.sync.deleted.some(row=>row.kind==='menu'&&row.id==='beer'));
  b=mergeState(b,removal,knownB);assert.equal(b.menu.beer,undefined);
});

test('bounded journal replays over 500 changes without dropping records, including repeated writes in one second',async()=>{
  const f=fixture(),first=await snapshot(f),known=new Map();let state=mergeState({},first,known);
  f.sqlite.exec('BEGIN');for(let i=0;i<510;i++)f.put('menu',`item-${i}`,{name:`Item ${i}`,price:i});f.sqlite.exec('COMMIT');
  f.put('menu','item-0',{name:'Updated again',price:99});
  const page=await delta(f,first.sync.cursor);assert.equal(page.sync.more,true);
  state=mergeState(state,page,known);state=mergeState(state,await delta(f,page.sync.cursor),known);
  assert.equal(Object.keys(state.menu).length,511);assert.equal(state.menu['item-0'].price,99);
  const count=f.sqlite.prepare("SELECT COUNT(*) AS n FROM record_changes WHERE kind='menu' AND record_id='item-0'").get();assert.equal(count.n,1);
});

test('delayed history cannot resurrect deletions or overwrite newer cancellations',()=>{
  const state={sales:{sale:{price:8}}},versions=new Map([['sales:sale',5]]);
  mergeRecords(state,'sales',{sale:{price:1}},{'sales:sale':3},versions);assert.equal(state.sales.sale.price,8);
  mergeState(state,{sales:{},sync:{incremental:true,cursor:7,deleted:[{kind:'sales',id:'sale'}],versions:{'sales:sale':7}}},versions);
  mergeRecords(state,'sales',{sale:{price:8}},{'sales:sale':5},versions);assert.equal(state.sales.sale,undefined);
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
  assert.equal((await worker.fetch(new Request(`http://localhost/api/state?since=${body.sync.cursor}`,{headers:{authorization:'Bearer test-token'}}),f.env)).status,401);
});

test('transaction rollback does not publish phantom revisions or balances',async()=>{
  const f=fixture(),first=await snapshot(f);
  f.put('recipes','beer',{components:[{stock_item_id:'missing',quantity:1}]});
  const before=await snapshot(f);
  const response=await f.call({action:'sale.checkout',destination:'sale',payment_method:'Digital',items:[{menu_id:'beer',quantity:1}]});assert.equal(response.status,400);
  assert.equal((await delta(f,before.sync.cursor)).sync.cursor,before.sync.cursor);assert.equal(f.balance('beer'),0);
  assert.ok(before.sync.cursor>first.sync.cursor);
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

test('polling pauses in hidden tabs, resumes on visibility and uses slower administrative intervals',async()=>{
  assert.equal(refreshDelay('Cozinha','kitchen'),3000);assert.equal(refreshDelay('Admin','cash'),15000);assert.equal(refreshDelay('Admin','stock'),30000);
  assert.equal(refreshDelay('Admin','menu'),60000);assert.equal(refreshDelay('Frente de caixa','sales'),3000);
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),listeners={};let tick,loads=0,draws=0;
  const context={document:{hidden:true,addEventListener:(name,callback)=>listeners[name]=callback},refreshDelay,loadPending:null,module:'Admin',page:'cash',setInterval:callback=>{tick=callback},clearInterval(){},refreshTimer:null,token:'admin',deviceToken:'',originToken:'',load:async()=>{loads++},draw:()=>draws++,showSyncError:assert.fail};
  runInNewContext(source.split('\n').find(line=>line.startsWith('function startRefresh('))+'\nstartRefresh(true);',context);
  tick();assert.equal(loads,0);context.document.hidden=false;tick();assert.equal(loads,1);
  const visibility=source.slice(source.indexOf('document.addEventListener("visibilitychange"'),source.indexOf('document.addEventListener("online"'));
  runInNewContext(visibility,context);context.document.hidden=true;listeners.visibilitychange();assert.equal(loads,1);
  context.document.hidden=false;listeners.visibilitychange();await new Promise(resolve=>setImmediate(resolve));assert.equal(loads,2);assert.equal(draws,1);
});

test('sync preserves immutable D1 bind results and reports measured data reads',async()=>{
  const f=fixture();
  const db={prepare(sql){
    const make=args=>({bind:(...values)=>make(values),async all(){const statement=f.env.DB.prepare(sql);if(args)statement.bind(...args);const result=await statement.all();return {...result,meta:{rows_read:result.results.length}}}});
    return make(null);
  }};
  const first=await syncState(db,params({}),admin);
  assert.equal(first.menu.beer.price,8);assert.equal(first.sync.usage.available,true);
  const idle=await syncState(db,params({since:String(first.sync.cursor)}),admin);
  assert.deepEqual(idle.menu,{});assert.equal(idle.sync.usage.data_rows_read,1);
});
