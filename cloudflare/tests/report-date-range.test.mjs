import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function context(){const c={summaryCalendarMonth:'2026-11',localDay:value=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value))};runInNewContext(source.slice(source.indexOf('function validReportDate('),source.indexOf('function groupedOrders(')),c);return c;}
test('custom range includes both São Paulo boundaries and entire operational cash',()=>{
 const c=context(),cash=[['night',{opened_at:'2026-11-02T02:00:00Z'}],['next',{opened_at:'2026-11-02T03:00:00Z'}]];
 const sales=[['before',{created_at:'2026-11-01T02:59:59.999Z'}],['first',{created_at:'2026-11-01T03:00:00Z'}],['last',{created_at:'2026-11-02T02:59:59.999Z'}],['after',{created_at:'2026-11-02T03:00:00Z'}],['night-sale',{cash_session_id:'night',created_at:'2026-11-02T06:00:00Z'}],['next-sale',{cash_session_id:'next'}]];
 const result=c.periodSelection(sales,cash,'range:2026-11-01,2026-11-01');
 assert.deepEqual(Array.from(result.sales,([id])=>id),['first','last','night-sale']);
 assert.equal(result.start.toISOString(),'2026-11-01T03:00:00.000Z');
 assert.equal(result.end.toISOString(),'2026-11-02T02:59:59.999Z');
 assert.deepEqual(Array.from(c.periodSelection(sales,cash,'day:2026-11-01').sales,([id])=>id),['first','last','night-sale']);
});
test('dates reject missing values, impossible dates and accept leap days',()=>{
 const c=context();for(const value of ['',undefined,'2026-02-29','2026-04-31','2026-1-01','2026-13-01'])assert.equal(c.validReportDate(value),false);
 for(const value of ['2024-02-29','2026-11-01'])assert.equal(c.validReportDate(value),true);
});
test('editing a range preserves unfinished draft without applying it',()=>{
 let input;const c={summaryRangeDraft:null,summaryFilter:'day:2026-11-01',document:{addEventListener:(_,handler)=>{input=handler}}};
 runInNewContext(source.slice(source.indexOf('document.addEventListener("input",event=>{'),source.indexOf('document.addEventListener("keydown",event=>{')),c);
 const values={date_from:{value:'2026-10-01'},date_to:{value:''}};
 const target={matches:selector=>selector===".overview-custom-range input[type='date']",form:{elements:values}};
 input({target});assert.deepEqual(Array.from(c.summaryRangeDraft),['2026-10-01','']);
 values.date_to.value='2026-10-31';input({target});assert.deepEqual(Array.from(c.summaryRangeDraft),['2026-10-01','2026-10-31']);assert.equal(c.summaryFilter,'day:2026-11-01');
});
test('polling leaves date controls intact on both cash and summary pages',()=>{
 const start=source.indexOf('    const choosingOverviewDate=');
 const code=source.slice(start,source.indexOf('\n  }',start));
 for(const page of ['cash','summary'])for(const focused of [true,false]){
  let draws=0;runInNewContext(code,{page,document:{activeElement:{matches:()=>focused}},draw:()=>draws++});assert.equal(draws,focused?0:1);
 }
});
test('applying validates order and missing dates before changing report; valid range updates calendar',()=>{
 const start=source.indexOf('    if(form.dataset.form==="summary-range"){');
 const code='(function(){'+source.slice(start,source.indexOf('    if(form.dataset.form==="history-filter")',start))+'})()';
 const c=context();Object.assign(c,{form:{dataset:{form:'summary-range'}},summaryFilter:'original',summaryRangeDraft:['draft'],historyPage:5,draw:()=>{}});
 for(const fd of [{date_from:'',date_to:''},{date_from:'2026-11-02',date_to:'2026-11-01'},{date_from:'2026-02-30',date_to:'2026-11-01'}]){c.fd=fd;assert.throws(()=>runInNewContext(code,c));assert.equal(c.summaryFilter,'original');}
 c.fd={date_from:'2026-10-01',date_to:'2026-11-01'};runInNewContext(code,c);assert.equal(c.summaryFilter,'range:2026-10-01,2026-11-01');assert.equal(c.summaryRangeDraft,null);assert.equal(c.summaryCalendarMonth,'2026-10');assert.equal(c.historyPage,1);
});
