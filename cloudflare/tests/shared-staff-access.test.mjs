import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,worker} from './fixture.mjs';
async function device(f){const response=await worker.fetch(new Request('http://localhost/api/access',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'front'})}),f.env);return{'x-device-access':(await response.json()).access_token}}
test('different devices can reuse their own request IDs without suppressing another device order',async()=>{
 const f=fixture();try{
  const a=await device(f),b=await device(f);assert.notEqual(a['x-device-access'],b['x-device-access']);
  const payload={action:'sale.checkout',request_id:'same-id-on-two-devices',destination:'sale',payment_method:'Digital',items:[{menu_id:'beer',quantity:1}]};
  const first=await f.call(payload,a),second=await f.call(payload,b);
  assert.equal(first.status,200);assert.equal(second.status,200);assert.notEqual(first.id,second.id);
  assert.equal((await f.call(payload,a)).id,first.id);assert.equal((await f.call(payload,b)).id,second.id);
  assert.equal(f.records('sales').length,2);assert.equal(f.balance('beer'),-2);
 }finally{f.sqlite.close()}
});
test('an order appended by another device after the initial read is preserved on the same tab',async()=>{
 const f=fixture();try{
  f.put('accounts','tab',{account_type:'tab',cash_session_id:'cash',status:'open',customer_name:'Mesa',items:[],payments_total:0});
  const prepare=f.env.DB.prepare;let injected=false;
  f.env.DB.prepare=sql=>{
   if(sql.startsWith('UPDATE records SET data=json_insert(')&&!injected){injected=true;f.sqlite.prepare("UPDATE records SET data=json_insert(data,'$.items[#]',json(?)) WHERE kind='accounts' AND id='tab'").run(JSON.stringify({id:'other-device-order',quantity:1,price:8}));}
   return prepare(sql);
  };
  const response=await f.call({action:'sale.checkout',destination:'tab',account_id:'tab',items:[{menu_id:'beer',quantity:2}]});
  assert.equal(response.status,200);assert.equal(injected,true);
  const items=f.records('accounts')[0].items;assert.equal(items.length,2);assert.equal(items[0].id,'other-device-order');assert.equal(items[1].quantity,2);
 }finally{f.sqlite.close()}
});
