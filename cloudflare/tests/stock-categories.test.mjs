import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixture } from './fixture.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const config=source.slice(source.indexOf('const quickStockCategories ='),source.indexOf('function quickStockRow('));
const categories=runInNewContext(config+';quickStockCategories');

test('category registration preserves measures, balances and optional costs in one batch',async()=>{
  const f=fixture();
  const items=Object.entries(categories).flatMap(([stock_category,category])=>category.units.map(([unit],i)=>({name:`${stock_category} ${unit}`,stock_category,unit,package_quantity:i+0.5,package_cost:i===0?'':2,default_units_per_package:1})));
  const result=await f.call({action:'stock.quick.create',items});
  assert.equal(result.status,200,JSON.stringify(result));
  for(const item of items){
    const saved=f.records('stock_items').find(row=>row.name===item.name);
    assert.equal(saved.stock_category,item.stock_category);
    assert.equal(saved.unit,item.unit);
    assert.equal(f.balance(saved.id),item.package_quantity);
    assert.equal(saved.cost_price,item.package_cost===''?0:2);
  }
});
