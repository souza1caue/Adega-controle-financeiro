import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fixture, worker } from './fixture.mjs';
const sale = (id, quantity=2, extra={}) => ({action:'sale.checkout',id,items:[{menu_id:'beer',quantity}],payment_method:'Pix',...extra});
const entry = (quantity,cost=5) => ({action:'stock.item.move',id:'beer',type:'in',quantity,unit_cost:cost,responsible:'Teste',reason:'Reposição'});

test('migration preserves old balances and timestamps', () => {
  const db = new DatabaseSync(':memory:');
  for(const name of ['0001_initial.sql','0002_atomic_stock.sql']) db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.exec("INSERT INTO stock_balances VALUES('old',2.5,'2026-01-01')");
  db.exec(readFileSync(new URL('../migrations/0003_allow_negative_stock.sql',import.meta.url),'utf8'));
  assert.deepEqual({...db.prepare('SELECT * FROM stock_balances').get()},{id:'old',quantity:2.5,updated_at:'2026-01-01'});
  db.exec('UPDATE stock_balances SET quantity=-1');
  db.close();
});
test('sale below zero is audited; partial cancellation and replenishment preserve balances and costs', async () => {
  const f=fixture();
  assert.equal((await f.call(sale('order1'))).status,200);
  assert.equal((await f.call(sale('order2',3))).status,200);
  assert.equal(f.balance('beer'),-5);
  assert.deepEqual(f.records('stock_movements').map(m=>[m.balance_before,m.balance_after,m.stock_shortage]),[[0,-2,1],[-2,-5,1]]);
  assert.equal((await f.call({action:'sale.order.void',order_id:'order1',responsible:'Teste',reason:'Cancelado'})).status,200);
  assert.equal(f.balance('beer'),-3);
  assert.equal((await f.call(entry(3))).status,200);
  assert.equal(f.balance('beer'),0);
  assert.equal(f.records('stock_items')[0].cost_price,5);
  assert.equal((await f.call(entry(2,0))).status,200);
  assert.equal(f.records('stock_items')[0].cost_price,0);
  assert.equal(f.records('stock_movements').at(-1).unit_cost,0);
});
test('shared ingredients deduct combined demand and invalid recipes roll back the order',async()=>{
  const f=fixture();f.put('menu','second',{name:'Outra cerveja',price:9,category:'Bebidas'});f.put('recipes','second',{components:[{stock_item_id:'beer',quantity:2}]});
  assert.equal((await f.call({...sale('shared'),items:[{menu_id:'beer',quantity:2},{menu_id:'second',quantity:3}]})).status,200);
  assert.equal(f.balance('beer'),-8);
  f.put('recipes','second',{components:[{stock_item_id:'removed',quantity:1}]});
  assert.equal((await f.call({...sale('bad'),items:[{menu_id:'beer',quantity:1},{menu_id:'second',quantity:1}]})).status,400);
  assert.equal(f.balance('beer'),-8);assert.equal(f.records('sales').length,2);
});
test('tab, credit and direct account orders can sell without balance',async()=>{
  for(const destination of ['tab','account']){
    const f=fixture();assert.equal((await f.call(sale('order',2,{destination,customer_name:'Teste'}))).status,200);assert.equal(f.balance('beer'),-2);
  }
  const f=fixture();f.put('accounts','credit',{customer_name:'Teste',account_type:'customer',items:[]});
  assert.equal((await f.call({action:'account.addItem',id:'credit',menu_id:'beer',description:'Cerveja',quantity:2,price:8})).status,200);assert.equal(f.balance('beer'),-2);
});
test('legacy controlled products also deduct and restore negative stock',async()=>{
  const f=fixture();f.sqlite.exec("DELETE FROM records WHERE kind='recipes'");f.put('menu','beer',{name:'Cerveja',price:8,category:'Bebidas',stock_controlled:true,stock_quantity:0});
  assert.equal((await f.call(sale('legacy'))).status,200);assert.equal(f.records('menu')[0].stock_quantity,-2);
  assert.equal((await f.call({action:'sale.order.void',order_id:'legacy',reason:'Teste',responsible:'Teste'})).status,200);assert.equal(f.records('menu')[0].stock_quantity,0);
});
test('loss still rejects insufficient stock and writes no movement',async()=>{
  const f=fixture();const response=await f.call({...entry(2),type:'loss'});assert.equal(response.status,409);assert.equal(f.balance('beer'),0);assert.equal(f.records('stock_movements').length,0);
});
test('quick registration supports zero, optional cost and correct unit cost',async()=>{
  const f=fixture();const response=await f.call({action:'stock.quick.create',responsible:'Teste',items:[{name:'Água',package_quantity:24,package_cost:2.5},{name:'Gelo',package_quantity:0,package_cost:''}]});
  assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.total_cost,60);
  const water=f.records('stock_items').find(i=>i.name==='Água'),ice=f.records('stock_items').find(i=>i.name==='Gelo');
  assert.equal(f.balance(water.id),24);assert.equal(water.cost_price,2.5);assert.equal(water.unit,'un');assert.equal(f.balance(ice.id),0);assert.equal(ice.cost_price,0);
  assert.equal(f.records('stock_movements').length,1);
});
test('invalid and duplicate quick registrations leave no partial items',async()=>{
  for(const items of [[{name:'Novo',package_quantity:2},{name:'CERVEJA',package_quantity:1}],[{name:'Água',package_quantity:1},{name:'agua',package_quantity:1}],[{name:'Novo',package_quantity:-1}]]){
    const f=fixture();assert.equal((await f.call({action:'stock.quick.create',responsible:'Teste',items})).status,400);assert.equal(f.records('stock_items').length,1);assert.equal(f.records('stock_movements').length,0);
  }
});
test('purchases and invoice imports on negative balances keep valid costs',async()=>{
  for(const amount of [1,2,3]){
    const f=fixture();await f.call(sale('order'));
    assert.equal((await f.call({action:'stock.purchase.batch',responsible:'Teste',items:[{id:'beer',package_quantity:amount,units_per_package:1,purchase_unit:'direct',package_cost:4}]})).status,200);
    assert.equal(f.balance('beer'),amount-2);assert.equal(f.records('stock_items')[0].cost_price,4);
  }
});
test('purchase lines treat package_cost as total paid and calculate unit cost by item, kilo or liter',async()=>{
  const f=fixture();
  const cases=[
    {id:'unit',name:'Unidades',unit:'un',quantity:12,total:120,expected:10},
    {id:'weight',name:'Farinha',unit:'kg',quantity:2.5,total:37.5,expected:15},
    {id:'volume',name:'Xarope',unit:'L',quantity:3,total:45,expected:15},
  ];
  for(const item of cases){
    f.put('stock_items',item.id,{name:item.name,unit:item.unit,cost_price:0});
    f.sqlite.prepare('INSERT INTO stock_balances(id,quantity) VALUES(?,0)').run(item.id);
  }
  const response=await f.call({action:'stock.purchase.batch',responsible:'Teste',items:cases.map(item=>({id:item.id,package_quantity:item.quantity,units_per_package:1,purchase_unit:'direct',total_paid:item.total}))});
  assert.equal(response.status,200,JSON.stringify(response));
  for(const item of cases){const saved=f.records('stock_items').find(row=>row.id===item.id);assert.equal(f.balance(item.id),item.quantity);assert.equal(saved.cost_price,item.expected);}
  assert.equal(response.total_cost,202.5);
});
test('stock policy reaches front devices and quick creation stays admin only',async()=>{
  const f=fixture();const {createHash}=await import('node:crypto');f.put('device_access','front',{role:'front',token_hash:createHash('sha256').update('front').digest('hex')});
  const response=await worker.fetch(new Request('http://localhost/api/state',{headers:{'x-device-access':'front'}}),f.env);assert.equal((await response.json()).stock_policy.allow_sales_without_stock,true);
  assert.equal((await f.call(sale('front'),{'x-device-access':'front'})).status,200);
  assert.equal((await f.call({action:'stock.quick.create',responsible:'Teste',items:[{name:'Novo',package_quantity:0}]},{'x-device-access':'front'})).status,403);
});

test('invoice entries and counted adjustments regularize negative stock',async()=>{
  const f=fixture();await f.call(sale('order',5));
  assert.equal((await f.call({action:'stock.invoice.import',invoice_key:'test-invoice',responsible:'Teste',items:[{name:'Cerveja',quantity:2,unit_cost:4}]})).status,200);
  assert.equal(f.balance('beer'),-3);assert.equal(f.records('stock_items')[0].cost_price,4);
  assert.equal((await f.call({action:'stock.item.move',id:'beer',type:'adjustment',new_balance:7,reason:'Contagem',responsible:'Teste'})).status,200);assert.equal(f.balance('beer'),7);
});


test('saved packaging does not multiply initial count and replenishment offsets sales',async()=>{
  const f=fixture();
  assert.equal((await f.call({action:'stock.quick.create',responsible:'Teste',items:[{name:'Lata modelo',unit:'un',package_quantity:2,default_units_per_package:12}]})).status,200);
  const item=f.records('stock_items').find(item=>item.name==='Lata modelo');
  assert.equal(f.balance(item.id),2);assert.equal(item.units_per_package,12);assert.equal(item.purchase_unit,'package');
  f.put('recipes','beer',{components:[{stock_item_id:item.id,quantity:1}]});
  assert.equal((await f.call(sale('pending-model',7))).status,200);
  assert.equal(f.balance(item.id),-5);
  assert.equal((await f.call({action:'stock.purchase.batch',responsible:'Teste',items:[{id:item.id,purchase_unit:item.purchase_unit,units_per_package:item.units_per_package,package_quantity:3,total_paid:108}]})).status,200);
  assert.equal(f.balance(item.id),31);
  const saved=f.records('stock_items').find(row=>row.id===item.id);
  assert.equal(saved.cost_price,3);assert.equal(saved.purchase_count,1);assert.equal(saved.units_per_package,12);
});
test('invalid saved packaging leaves initial registration untouched',async()=>{
  const f=fixture();
  assert.equal((await f.call({action:'stock.quick.create',responsible:'Teste',items:[{name:'Invalid model',package_quantity:2,default_units_per_package:0}]})).status,400);
  assert.equal(f.records('stock_items').length,1);
});
