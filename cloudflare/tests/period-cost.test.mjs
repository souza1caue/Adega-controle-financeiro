import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixture } from './fixture.mjs';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function report(data,liveCost=0){
 const context={data,entries:Object.entries,summaryCalendarMonth:'2026-10',cashProject:()=>'',date:String,cashLive:()=>({sales:[],salesTotal:0}),dayOperatingCosts:()=>({total:liveCost}),saleActualCost:sale=>Number(sale.unit_cost||0)*Number(sale.quantity||0),salesCostsAreKnown:()=>true};
 runInNewContext(source.slice(source.indexOf('function periodSelection('),source.indexOf('function groupedOrders('))+'\n'+source.slice(source.indexOf('function periodCostMetrics('),source.indexOf('const overviewPageBeforeSimplifiedMetrics='))+'\n'+source.slice(source.indexOf('function cashSummaryMetrics('),source.indexOf('function cashSummaryCards(')),context);
 return context;
}

test('reports keep saved daily cost after closing, reopening and changing current costs',async()=>{
 const f=fixture();
 try{
  assert.equal((await f.call({action:'staff.cost.total',amount:120})).status,200);
  assert.equal((await f.call({action:'cash.close',id:'cash',counted_cash:0})).status,200);
  const closed=f.records('cash')[0];
  assert.equal(closed.closing_summary.cost,120);
  assert.equal((await f.call({action:'cash.open',id:'next',opening_amount:0})).status,200);
  assert.equal((await f.call({action:'staff.cost.total',amount:350})).status,200);
  const data={cash:Object.fromEntries(f.records('cash').map(item=>[item.id,item])),stock_events:{}};
  const screen=report(data,350);
  const old=screen.periodCostMetrics({periodCashIds:new Set(['cash']),sales:[]});
  assert.equal(old.cost,120);
  assert.equal(screen.periodCostMetrics({periodCashIds:new Set(['next']),sales:[]}).cost,350);
  assert.equal(screen.periodCostMetrics({periodCashIds:new Set(['cash','next']),sales:[]}).cost,470);
  assert.equal(f.records('cash').find(item=>item.id==='cash').closing_summary.cost,120);
 }finally{f.sqlite.close()}
});

test('day and range selections sum only saved costs for the selected cash sessions',()=>{
 const cash={a:{status:'closed',opened_at:'2026-10-20T12:00:00',closing_summary:{cost:100,known:true}},b:{status:'closed',opened_at:'2026-10-21T12:00:00',closing_summary:{cost:250,known:true}},c:{status:'closed',opened_at:'2026-10-21T14:00:00',closing_summary:{cost:50,known:true}}};
 const screen=report({cash,stock_events:{}},9999),options=Object.entries(cash);
 assert.equal(screen.periodCostMetrics(screen.periodSelection([],options,'day:2026-10-21')).cost,300);
 assert.equal(screen.periodCostMetrics(screen.periodSelection([],options,'range:2026-10-20,2026-10-21')).cost,400);
 assert.equal(screen.periodCostMetrics(screen.periodSelection([],options,'day:2026-10-22')).cost,0);
 assert.equal(screen.periodCostMetrics(screen.periodSelection([],[options[1]],'day:2026-10-21')).cost,250);
});

test('closed costs remain frozen while legacy cash and sales still have a fallback',()=>{
 const data={cash:{old:{status:'closed'},frozen:{status:'closed',closing_summary:{cost:0,known:false}}},stock_events:{}};
 const screen=report(data,70);
 assert.equal(screen.periodCostMetrics({periodCashIds:new Set(['old']),sales:[]}).cost,70);
 const saved=screen.periodCostMetrics({periodCashIds:new Set(['frozen']),sales:[]});
 assert.equal(saved.cost,0);assert.equal(saved.known,false);
 assert.equal(screen.periodCostMetrics({periodCashIds:new Set(),sales:[['legacy',{quantity:2,unit_cost:5}]]}).cost,10);
});
