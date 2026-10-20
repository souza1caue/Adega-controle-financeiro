import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixture } from './fixture.mjs';

test('fixed menu cost persists, prices owner tabs and snapshots sales across mode changes', async () => {
  const f=fixture();
  assert.equal((await f.call({action:'menu.cost.mode',mode:'fixed'})).status,200);
  assert.equal((await f.call({action:'menu.save',id:'beer',name:'Beer',price:8,category:'Bebidas',fixed_cost_price:2.5,components:[{stock_item_id:'beer',quantity:1}]})).status,200);
  assert.equal((await f.call({action:'account.create',id:'owner',account_type:'tab',customer_name:'Owner',owner_pricing:true})).status,200);
  assert.equal((await f.call({action:'sale.checkout',destination:'tab',account_id:'owner',items:[{menu_id:'beer',quantity:2}]})).status,200);
  const sale=f.records('sales')[0];
  assert.equal(sale.price,2.5);assert.equal(sale.unit_cost,2.5);assert.equal(sale.stock_usage[0].unit_cost,3);
  assert.equal(f.balance('beer'),-2);
  assert.equal((await f.call({action:'menu.cost.mode',mode:'stock'})).status,200);
  assert.equal((await f.call({action:'sale.checkout',destination:'sale',payment_method:'Digital',items:[{menu_id:'beer',quantity:1}]})).status,200);
  assert.deepEqual(f.records('sales').map(s=>s.unit_cost),[2.5,3]);
  assert.equal(f.records('menu')[0].fixed_cost_price,2.5);
});

test('fixed cost works without recipe and rejects invalid values and unauthorized switches',async()=>{
  const f=fixture();
  assert.equal((await f.call({action:'menu.cost.mode',mode:'bad'})).status,400);
  assert.equal((await f.call({action:'menu.cost.mode',mode:'fixed'},{})).status,401);
  assert.equal((await f.call({action:'menu.save',id:'beer',name:'Beer',price:8,fixed_cost_price:-1})).status,400);
  await f.call({action:'menu.save',id:'beer',name:'Beer',price:8,fixed_cost_price:4,components:[]});
  await f.call({action:'menu.cost.mode',mode:'fixed'});
  assert.equal((await f.call({action:'sale.checkout',destination:'sale',payment_method:'Digital',items:[{menu_id:'beer',quantity:2}]})).status,200);
  assert.equal(f.records('sales')[0].unit_cost,4);
});

test('menu switch marks selected mode and reveals saved fixed cost input',()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const line=name=>source.split('\n').find(l=>l.startsWith(`function ${name}(`));
  const context={data:{settings:{menu_cost:{mode:'fixed'}},menu:{beer:{name:'Beer',price:8,fixed_cost_price:2.5}},recipes:{},stock_items:{}},entries:Object.entries,esc:String,money:n=>`R$ ${n}`,category:()=> 'Bebidas',heading:(title,action)=>title+action,openModal:html=>context.html=html};
  runInNewContext(source.split('\n').find(l=>l.startsWith('const fixedMenuCost'))+'\n'+['menuPage','menuCost','menuDialog'].map(line).join('\n')+'\nhtml=menuPage();',context);
  assert.match(context.html,/data-menu-cost-mode="fixed" aria-pressed="true"/);
  runInNewContext('menuDialog("beer")',context);
  assert.match(context.html,/name="fixed_cost_price"[^>]*value="2.5"/);
  context.data.settings.menu_cost.mode='stock';runInNewContext('menuDialog("beer")',context);
  assert.doesNotMatch(context.html,/name="fixed_cost_price"/);
});
