import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixture } from './fixture.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('function quickStockEntry('),source.indexOf('function updateQuickStockUnit('));
const cost=runInNewContext(functions+';quickStockCost');

test('unit and total costs agree for kilos, liters, cans and bundles',async()=>{
  for(const [unit,qty,size,price,total,balance,unitCost] of [['kg',2.5,1,20,50,2.5,20],['L',3,1,8,24,3,8],['latão',36,1,4,144,36,4],['fardo',3,12,48,144,36,4]]){
    for(const mode of ['unit','total']){
      const payload=cost(unit,qty,size,mode==='unit'?price:'',mode==='total'?total:'',mode);
      const f=fixture(),result=await f.call({action:'stock.quick.create',items:[{name:'New item',...payload}]});
      assert.equal(result.status,200,JSON.stringify(result));
      const item=f.records('stock_items').find(item=>item.name==='New item');
      assert.equal(f.balance(item.id),balance);assert.equal(item.cost_price,unitCost);assert.equal(result.total_cost,total);
    }
  }
});

test('total remains authoritative without accumulating rounding from displayed unit price',async()=>{
  const payload=cost('fardo',3,12,33.333333,100,'total');
  const f=fixture(),result=await f.call({action:'stock.quick.create',items:[{name:'Rounded bundle',...payload}]});
  assert.equal(result.status,200);assert.equal(result.total_cost,100);
  assert.equal(f.records('stock_items').find(item=>item.name==='Rounded bundle').cost_price,2.7778);
});

test('missing and invalid cost or total on zero quantity cannot be staged',()=>{
  assert.throws(()=>cost('kg',2,1,'',''));
  assert.throws(()=>cost('kg',2,1,-1,''));
  assert.throws(()=>cost('kg',2,1,'',NaN,'total'));
  assert.throws(()=>cost('un',0,1,'',10,'total'));
  assert.equal(cost('un',0,1,5,'').package_cost,5);
  assert.equal(cost('un',3,1,0,'').total_paid,0);
});

test('server rejects missing cost atomically and accepts total-only registration',async()=>{
  for(const invalid of [{package_quantity:2},{package_quantity:2,package_cost:'',total_paid:''},{package_quantity:0,total_paid:10}]){
    const f=fixture();
    const result=await f.call({action:'stock.quick.create',items:[{name:'Valid',package_quantity:1,package_cost:3},{name:'Invalid',...invalid}]});
    assert.equal(result.status,400);assert.equal(f.records('stock_items').length,1);assert.equal(f.records('stock_movements').length,0);
  }
  const f=fixture();assert.equal((await f.call({action:'stock.quick.create',items:[{name:'Total only',unit:'kg',package_quantity:2.5,total_paid:50}]})).status,200);
  assert.equal(f.records('stock_items').find(item=>item.name==='Total only').cost_price,20);
});

test('selecting an existing item adds stock using its saved measure and bundle size',async()=>{
  const f=fixture();
  const existing=f.records('stock_items').find(item=>item.id==='beer');
  existing.purchase_unit='package';existing.units_per_package=12;existing.stock_category='Bebida';
  f.put('stock_items','beer',existing);f.sqlite.exec("UPDATE stock_balances SET quantity=5 WHERE id='beer'");
  const result=await f.call({action:'stock.quick.create',items:[{id:'beer',name:existing.name,stock_category:'Bebida',unit:'un',package_quantity:36,default_units_per_package:12,package_cost:2,total_paid:72}]});
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.balance('beer'),41);assert.equal(result.created,0);assert.equal(result.total_units,36);assert.equal(result.total_cost,72);
  const saved=f.records('stock_items').find(item=>item.id==='beer');assert.equal(saved.units_per_package,12);assert.equal(saved.purchase_count,1);
});

test('existing item selection must match an actual saved item and its name',async()=>{
  for(const item of [{id:'missing',name:'Cerveja',package_quantity:1,package_cost:2},{id:'beer',name:'Different item',package_quantity:1,package_cost:2},{id:'beer',name:'Cerveja',unit:'kg',package_quantity:1,package_cost:2}]){
    const f=fixture(),result=await f.call({action:'stock.quick.create',items:[item]});
    assert.equal(result.status,400);assert.equal(f.balance('beer'),0);assert.equal(f.records('stock_movements').length,0);
  }
});
