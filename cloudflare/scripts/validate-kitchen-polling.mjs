// Use only the disposable local Wrangler database described in SYNC.md.
import assert from 'node:assert/strict';
const base=process.env.KITCHEN_TEST_URL||'http://127.0.0.1:8788';
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname),'Never create test orders in production');
async function api(path,headers={},body){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const result=await response.json();assert.equal(response.ok,true,JSON.stringify(result));return result;
}
const {token}=await api('/api/login',{}, {password:process.env.KITCHEN_TEST_PASSWORD||'local-kitchen-test'});
const admin={authorization:`Bearer ${token}`},mutate=(body,headers=admin)=>api('/api/mutate',headers,body);
const initial=await api('/api/state',admin);
if(!Object.values(initial.cash).some(c=>c.status==='open'))await mutate({action:'cash.open',opening_amount:0});
const food=await mutate({action:'menu.save',name:'Local polling test',category:'Comidas',price:10,fixed_cost_price:2});
async function access(role){return{'x-device-access':(await api('/api/access',{}, {role})).access_token}}
const front=await access('front'),kitchen=await access('kitchen');
const payload={action:'sale.checkout',request_id:crypto.randomUUID(),customer_name:'Local test',destination:'sale',payment_method:'Digital',items:[{menu_id:food.id,quantity:2,note:'Local test only'}]};
const [first,retry]=await Promise.all([mutate(payload,front),mutate(payload,front)]);
assert.equal(first.id,retry.id);
assert.equal((await api('/api/state',kitchen)).kitchen[first.id].status,'pending');
for(const status of ['started','ready']){
  await mutate({action:'kitchen.status',id:first.id,status},kitchen);
  assert.equal((await api('/api/state',front)).kitchen[first.id].status,status);
}
await mutate({action:'kitchen.status',id:first.id,status:'delivered'},front);
assert.equal((await api('/api/state',kitchen)).kitchen[first.id].status,'delivered');
const complete=await api('/api/state?since=999999',front);
assert.equal(complete.sync,undefined);
assert.equal(Object.values(complete.sales).filter(s=>s.order_id===first.id).length,1);
console.log(JSON.stringify({result:'passed',environment:'local',transport:'direct full snapshots',checks:['concurrent retry','kitchen arrival','started','ready at front','delivery','complete state']}));
