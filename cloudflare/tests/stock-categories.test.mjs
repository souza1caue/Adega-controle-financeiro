import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixture } from './fixture.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const config=source.slice(source.indexOf('const quickStockCategories ='),source.indexOf('function quickStockRow('));
const categories=runInNewContext(config+';quickStockCategories');

test('category registration preserves measures, balances and explicit costs in one batch',async()=>{
  const f=fixture();
  const items=Object.entries(categories).flatMap(([stock_category,category])=>category.units.filter(([unit])=>unit!=='fardo').map(([unit],i)=>({name:`${stock_category} ${unit}`,stock_category,unit,package_quantity:i+0.5,package_cost:i===0?0:2,default_units_per_package:1})));
  const result=await f.call({action:'stock.quick.create',items});
  assert.equal(result.status,200,JSON.stringify(result));
  for(const item of items){
    const saved=f.records('stock_items').find(row=>row.name===item.name);
    assert.equal(saved.stock_category,item.stock_category);
    assert.equal(saved.unit,item.unit);
    assert.equal(f.balance(saved.id),item.package_quantity);
    assert.equal(saved.cost_price,item.package_cost);
  }
});

const entrySource=source.slice(source.indexOf('function quickStockEntry('),source.indexOf('function quickStockDialog('));
const entry=runInNewContext(entrySource+';quickStockEntry');

test('beverage bundles become individual stock units and remember packaging for purchases',async()=>{
  const f=fixture();
  const converted=entry('fardo',3,12);
  assert.equal(converted.package_quantity,36);
  const result=await f.call({action:'stock.quick.create',items:[{name:'Bundle beer',stock_category:'Bebida',...converted,package_cost:4}]});
  assert.equal(result.status,200,JSON.stringify(result));
  const saved=f.records('stock_items').find(item=>item.name==='Bundle beer');
  assert.equal(saved.unit,'un');assert.equal(f.balance(saved.id),36);
  assert.equal(saved.units_per_package,12);assert.equal(saved.purchase_unit,'package');
  assert.equal(saved.cost_price,4);assert.equal(result.total_cost,144);
  assert.equal((await f.call({action:'stock.purchase.batch',items:[{id:saved.id,purchase_unit:'package',units_per_package:saved.units_per_package,package_quantity:2,total_paid:96}]})).status,200);
  assert.equal(f.balance(saved.id),60);
});

test('bundle counts reject invalid sizes and switching to single units avoids multiplication',()=>{
  for(const [count,size] of [[1.5,12],[-1,12],[2,0],[2,-1],[2,2.5],[Infinity,12]])assert.throws(()=>entry('fardo',count,size));
  assert.equal(entry('fardo',0,12).package_quantity,0);
  assert.equal(entry('un',3,12).package_quantity,3);
  assert.equal(entry('kg',2.5,1).package_quantity,2.5);
});
