import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationAccessCache } from '../public/module-access.js';

test('module access is shared across prefetch and selection, and reused after a page reload',async()=>{
  const saved=new Map(),storage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)};
  let requests=0,resolveRequest;
  const request=async()=>{requests++;return new Promise(resolve=>{resolveRequest=()=>resolve({ok:true,json:async()=>({role:'front',access_token:'signed-front',expires_at:1000000})})})};
  const cache=createOperationAccessCache({request,storage,now:()=>0});
  const a=cache.get('front'),b=cache.get('front');assert.equal(requests,1);
  resolveRequest();assert.equal((await a).access_token,(await b).access_token);
  await cache.get('front');assert.equal(requests,1);
  const reloaded=createOperationAccessCache({request,storage,now:()=>0});
  assert.equal((await reloaded.get('front')).access_token,'signed-front');assert.equal(requests,1);
});

test('expired and rejected accesses can renew without mixing operational roles',async()=>{
  let clock=0,requests=0;
  const cache=createOperationAccessCache({storage:{getItem(){return null},setItem(){}},now:()=>clock,
    request:async(_,options)=>{const{role}=JSON.parse(options.body);return{ok:true,json:async()=>({role,access_token:`${role}-${++requests}`,expires_at:clock+120000})}}});
  const first=await cache.get('front');await cache.get('kitchen');assert.equal(requests,2);
  clock=61000;assert.notEqual((await cache.get('front')).access_token,first.access_token);
  assert.equal(requests,3);
  await cache.get('front',true);assert.equal(requests,4);
});

test('prefetch failures leave the choice screen usable and the selected role can retry',async()=>{
  let fail=true,requests=0;
  const cache=createOperationAccessCache({storage:{getItem(){return null},setItem(){}},
    request:async(_,options)=>{requests++;if(fail)throw new Error('offline');const{role}=JSON.parse(options.body);return{ok:true,json:async()=>({role,access_token:role,expires_at:Date.now()+120000})}}});
  const results=await cache.prefetch();assert.ok(results.every(result=>result.status==='rejected'));
  fail=false;assert.equal((await cache.get('kitchen')).role,'kitchen');assert.equal(requests,3);
});
