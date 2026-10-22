import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {fixture,worker} from './fixture.mjs';

const order={action:'sale.checkout',destination:'sale',payment_method:'Dinheiro',items:[{menu_id:'beer',quantity:1}]};
async function claim(f,token){const response=await worker.fetch(new Request('http://localhost/api/staff/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invite_token:token})}),f.env);return{status:response.status,...await response.json()}}

test('shared QR devices can order immediately without registering a name',async()=>{
 const f=fixture();try{
  const qr=await f.call({action:'staff.access.shared'});
  const a=await claim(f,qr.access_token),b=await claim(f,qr.access_token);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.notEqual(a.access_token,b.access_token);
  assert.equal((await f.call(order,{'x-staff-access':a.access_token})).status,200);
  assert.equal((await f.call(order,{'x-staff-access':b.access_token})).status,200);
  assert.equal(f.records('sales').length,2);assert.equal(f.balance('beer'),-2);
  assert.ok(f.records('sales').every(s=>s.source_name==='Caixa'));
  assert.equal(f.records('employees').length,0);assert.equal(f.records('staff_shifts').length,0);
  assert.equal((await f.call({action:'cash.open',opening_amount:0},{'x-staff-access':a.access_token})).status,403);
 }finally{f.sqlite.close()}
});

test('closing cash still revokes QR sessions without requiring identification',async()=>{
 const f=fixture();try{
  const qr=await f.call({action:'staff.access.shared'}),session=await claim(f,qr.access_token),headers={'x-staff-access':session.access_token};
  assert.equal((await f.call(order,headers)).status,200);
  assert.equal((await f.call({action:'cash.close',id:'cash',counted_cash:8,counted_account:0})).status,200);
  assert.equal((await claim(f,qr.access_token)).status,401);
  assert.equal((await f.call(order,headers)).status,400);
  assert.equal(f.records('sales')[0].source_name,'Caixa');
 }finally{f.sqlite.close()}
});

test('obsolete identity headers cannot block checkout or add personal attribution',async()=>{
 const f=fixture();try{
  f.put('menu','beer',{name:'Porcao',category:'Comidas',price:8});
  const headers={authorization:'Bearer test-token','x-front-identity':'expired-cached-identity'};
  assert.equal((await f.call({action:'account.create',id:'tab',account_type:'tab',customer_name:'Mesa'},headers)).status,200);
  assert.equal((await f.call({...order,destination:'tab',account_id:'tab'},headers)).status,200);
  assert.equal(f.records('accounts')[0].items[0].created_by,'Caixa principal');
  assert.equal(f.records('kitchen')[0].created_by,'Caixa principal');
  const response=await worker.fetch(new Request('http://localhost/api/state',{headers}),f.env);
  assert.equal(response.status,200);assert.equal((await response.json()).front_identity.source_name,'Caixa');
 }finally{f.sqlite.close()}
});

test('legacy identify calls store no names and do not create a new requirement',async()=>{
 const f=fixture();try{
  const before=f.records('staff_access').length;
  for(const name of ['','Ana','x'.repeat(100)])assert.equal((await f.call({action:'front.identify',name})).disabled,true);
  assert.equal(f.records('staff_access').length,before);
  assert.equal((await f.call(order)).status,200);
 }finally{f.sqlite.close()}
});

test('front draws sales directly without a name form or identity state',()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const context={module:'Frente de caixa',page:'sales',refreshTimer:null,data:{kitchen:{},front_identity:null},
  document:{activeElement:null,body:{classList:{toggle(){}}}},app:{classList:{toggle(){}},querySelector:()=>null},
  clearInterval(){},activeCash:()=>null,entries:Object.entries,setupNav(){},fiadoLabels:value=>value,
  salesPage:()=>'<div>Produtos para vender</div>',centerSaleCategory(){},startRefresh(){}};
 runInNewContext(source.slice(source.indexOf('function draw(){'),source.indexOf('\nfunction adminShell('))+'\ndraw();',context);
 assert.match(context.app.innerHTML,/Produtos para vender/);
 assert.doesNotMatch(source,/Quem está atendendo|data-form="front-identify"|Confirme seu nome|x-front-identity/);
});
