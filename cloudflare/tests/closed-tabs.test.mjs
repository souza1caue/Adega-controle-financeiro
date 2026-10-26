import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function screen(){
 const accounts={open:{account_type:'tab',status:'open',cash_session_id:'new',customer_name:'Open',items:[],payments_total:0},old:{account_type:'tab',status:'closed',cash_session_id:'old',customer_name:'João',closed_at:'2026-10-24T05:00:00Z',items:[{description:'Cerveja',quantity:5,price:8,created_at:'2026-10-24T04:00:00Z'}],payments_total:40},new:{account_type:'tab',status:'closed',cash_session_id:'new',customer_name:'Maria',closed_at:'2026-10-24T23:00:00Z',items:[],payments_total:0},credit:{account_type:'customer',status:'closed',customer_name:'Credit',items:[],payments_total:0}};
 const context={module:'Frente de caixa',tabStatusView:'closed',closedTabSearch:'',data:{accounts,cash:{old:{opened_at:'2026-10-23T22:00:00Z',status:'closed'},new:{opened_at:'2026-10-24T22:00:00Z',status:'open'}},account_payments:{cash:{account_id:'old',amount:5,payment_method:'Digital'},transfer:{account_id:'old',amount:35,payment_method:'Transferido para fiado',settlement_type:'transfer'}}},entries:Object.entries,activeCash:()=>['new',{}],heading:value=>value,esc:String,date:String,money:value=>'R$ '+value,empty:value=>value,systemLabel:String,accountCharges:a=>(a.items||[]).filter(i=>!i.cancelled_at).reduce((s,i)=>s+i.quantity*i.price,0),openModal:html=>context.html=html};
 context.accountPayments=id=>Object.entries(context.data.account_payments).filter(([,p])=>p.account_id===id&&!p.voided_at);
 const code=source.slice(source.indexOf('function tabsNavigation('),source.indexOf('function tabOrderLines('));
 runInNewContext(source.split('\n').find(l=>l.startsWith('function isMoneyReceipt('))+'\n'+code,context);
 return context;
}

test('closed tabs only show current cash and preserve accent-insensitive search',()=>{
 const s=screen();assert.deepEqual(s.closedTabEntries().tabs.map(([id])=>id),['new']);
 s.closedTabSearch='joao';assert.equal(s.closedTabEntries().tabs.length,0);
 s.closedTabSearch='maria';assert.deepEqual(s.closedTabEntries().tabs.map(([id])=>id),['new']);
 s.activeCash=()=>['old',{}];s.closedTabSearch='joao';assert.deepEqual(s.closedTabEntries().tabs.map(([id])=>id),['old']);
 s.activeCash=()=>null;s.closedTabSearch='';assert.equal(s.closedTabEntries().tabs.length,0);
 s.data.accounts.legacy={account_type:'tab',status:'closed'};assert.equal(s.closedTabEntries().tabs.length,0);
});

test('sidebar offers open and closed tabs and closed list has no add-item actions',()=>{
 const s=screen();const html=s.tabsNavigation(s.closedTabsPage());
 assert.match(html,/data-tab-view="open"/);assert.match(html,/data-tab-view="closed" aria-pressed="true"/);
 assert.doesNotMatch(html,/data-closed-tab-cash|Todos os caixas|data-account="old"/);assert.match(html,/data-closed-tab-search/);assert.match(html,/data-account="new"/);
 assert.doesNotMatch(html,/data-tab-add-items|data-new-account|data-account="open"|data-account="credit"/);
 s.activeCash=()=>null;assert.equal(s.closedTabEntries().tabs.length,0);
});

test('closed statement shows items and separates real payments from debt transfer, without editing controls',()=>{
 const s=screen(),before=JSON.stringify(s.data);s.closedTabDialog('old');
 assert.match(s.html,/Extrato da comanda/);assert.match(s.html,/Fechada/);assert.match(s.html,/Cerveja/);
 assert.match(s.html,/<span>Recebido<\/span><b>R\$ 5<\/b>/);
 assert.match(s.html,/<span>Transferido para fiado<\/span><b>R\$ 35<\/b>/);
 assert.match(s.html,/2026-10-23T22:00:00Z/);
 assert.doesNotMatch(s.html,/data-tab-add-items|data-account-payment|data-edit-account|data-cancel-account-item|data-convert-tab/);
 assert.equal(JSON.stringify(s.data),before);
});

test('closed and open tabs route to their respective statement screens',()=>{
 const s=screen();let closed,opened;
 s.closedTabDialog=id=>closed=id;s.tabHostedEvent=()=>null;s.accountDialogBeforeEventConsumption=id=>opened=id;
 runInNewContext(source.split('\n').find(l=>l.startsWith('accountDialog=function(id){const account=data.accounts[id];')),s);
 s.accountDialog('old');assert.equal(closed,'old');assert.equal(opened,undefined);
 s.accountDialog('open');assert.equal(opened,'open');
});
