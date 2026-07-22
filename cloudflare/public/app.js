const app = document.querySelector("#app");
const nav = document.querySelector("#nav");
const modal = document.querySelector("#modal");
const modalBody = document.querySelector("#modalBody");
let data = { menu:{}, accounts:{}, sales:{}, kitchen:{}, cash:{} };
let module = null, page = null, refreshTimer = null;
let token = sessionStorage.getItem("adminToken") || "";
let summaryFilter = "Diário";
let printMode = localStorage.getItem("printMode") || "test";
let printingBusy = false;
let cart = (()=>{try{return JSON.parse(localStorage.getItem("saleCart")||"{}")||{}}catch{return {}}})();

const esc = (v="") => String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = value => Number(value||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});
const date = value => value ? new Date(`${value}${value.length===10?'T12:00':''}`).toLocaleString("pt-BR",{dateStyle:"short",timeStyle:value.length>10?"short":undefined}) : "—";
const entries = object => Object.entries(object||{});
const activeCash = () => entries(data.cash).sort((a,b)=>(b[1].opened_at||"").localeCompare(a[1].opened_at||"")).find(([,c])=>c.status==="open");
const category = item => item.category || (/por[cç][aã]o|batata|carne|frango|lanche|comida/i.test(item.name)?"Comidas":"Bebidas");
const statusName = {pending:"Pendente",started:"Em andamento",ready:"Pronto",delivered:"Entregue",done:"Concluído"};
const cartLines = () => entries(cart).filter(([id,line])=>data.menu[id]&&Number(line.quantity)>0);
const cartQuantity = () => cartLines().reduce((sum,[,line])=>sum+Number(line.quantity),0);
const cartTotal = () => cartLines().reduce((sum,[id,line])=>sum+Number(line.quantity)*Number(data.menu[id].price),0);
function saveCart(){localStorage.setItem("saleCart",JSON.stringify(cart))}
function changeCart(id,delta){const next=Number(cart[id]?.quantity||0)+delta;if(next>0)cart[id]={quantity:next};else delete cart[id];saveCart();draw()}

async function load(render=true){
  const response=await fetch("/api/state");
  if(!response.ok) throw new Error("Não foi possível carregar os dados.");
  data=await response.json(); if(render) draw();
}
async function mutate(payload, admin=false){
  const response=await fetch("/api/mutate",{method:"POST",headers:{"content-type":"application/json",...(admin&&token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(payload)});
  const result=await response.json(); if(!response.ok) throw new Error(result.error||"Operação não concluída.");
  await load(false); toast("Alteração salva."); return result;
}
function toast(message,error=false){const box=document.querySelector("#toast");box.textContent=message;box.className=error?"show error":"show";setTimeout(()=>box.className="",2800)}
function openModal(html){modalBody.innerHTML=`<div class="modal-content">${html}</div>`;modal.showModal()}
function closeModal(){modal.close();modalBody.innerHTML=""}
function heading(title,action=""){return `<div class="section-head"><div><div class="eyebrow">${esc(module||"Sistema")}</div><h1>${esc(title)}</h1></div>${action}</div>`}
function empty(text){return `<div class="empty">${esc(text)}</div>`}

function portal(){
  nav.innerHTML="";
  app.innerHTML=`<section class="portal"><div class="eyebrow">Operação integrada</div><h1>Escolha o módulo desta máquina</h1><p class="subtitle">Cada tela acompanha os mesmos dados em tempo real.</p><div class="module-grid">
    ${[["Frente de caixa","Vendas, fiado e envio de comandas."],["Impressora","Impressão automática das comandas."],["Admin","Cardápio, caixa e relatórios."]].map(([name,desc])=>`<button class="module-card" data-module="${name}"><span>ACESSAR</span><b>${name}</b><span>${desc}</span></button>`).join("")}
  </div></section>`;
}
function setupNav(items){nav.innerHTML=items.map(([key,label])=>`<button data-page="${key}" class="${page===key?'nav-active':''}">${label}</button>`).join("")+`<button data-home class="ghost">Módulos</button>`}
function draw(){
  clearInterval(refreshTimer);
  if(!module)return portal();
  if(module==="Frente de caixa"){
    page ||= "sales"; setupNav([["sales","Saídas"],["accounts","Fiado"]]);
    app.innerHTML=page==="sales"?salesPage():accountsPage();
  }else if(module==="Impressora"){
    page="printer";setupNav([]);app.innerHTML=printerPage();refreshTimer=setInterval(()=>load(true).catch(()=>{}),3000);queueAutomaticPrint();
  }else{
    if(!token){setupNav([]);app.innerHTML=loginPage();return}
    page ||= "summary";setupNav([]);
    const content=page==="summary"?summaryPage():page==="menu"?menuPage():page==="cash"?cashPage():page==="adminSales"?salesHistory():page==="accounts"?accountsPage():printerPage();
    app.innerHTML=adminShell(content);
    if(page==="adminPrinter"){refreshTimer=setInterval(()=>load(true).catch(()=>{}),3000);queueAutomaticPrint()}
  }
}

function adminShell(content){const groups=[["Operação",[["summary","Visão geral"],["cash","Controle de caixa"]]],["Cadastros",[["menu","Cardápio"],["accounts","Cadernetas"]]],["Acompanhamento",[["adminSales","Histórico de vendas"],["adminPrinter","Central de impressão"]]]];return `<div class="admin-layout"><aside class="admin-sidebar"><div class="admin-identity"><span class="eyebrow">Administração</span><b>Controle da Adega</b></div>${groups.map(([label,items])=>`<div class="admin-nav-group"><small>${label}</small>${items.map(([key,text])=>`<button data-page="${key}" class="${page===key?'nav-active':''}">${text}</button>`).join("")}</div>`).join("")}<button class="ghost admin-logout" data-admin-logout>Sair do Admin</button></aside><section class="admin-content">${content}</section></div>`}

function salesPage(){
  const open=activeCash();
  const groups=["Bebidas","Comidas"].map(cat=>`<section><h2>${cat}</h2><div class="cards product-grid">${entries(data.menu).filter(([,item])=>category(item)===cat).sort((a,b)=>a[1].name.localeCompare(b[1].name)).map(([id,item])=>`<article class="card"><h3>${esc(item.name)}</h3><div class="price">${money(item.price)}</div><div class="card-footer"><span class="muted">${cart[id]?.quantity?`${cart[id].quantity} no pedido`:cat}</span><button class="primary" data-cart-add="${id}">+ Adicionar</button></div></article>`).join("")||empty(`Nenhum item em ${cat.toLowerCase()}.`)}</div></section>`).join("");
  const lines=cartLines();
  const cartPanel=`<aside class="cart-panel"><div class="cart-title"><div><span class="eyebrow">Pedido atual</span><h2>${cartQuantity()} ${cartQuantity()===1?'item':'itens'}</h2></div>${lines.length?`<button class="ghost" data-cart-clear>Limpar</button>`:""}</div><div class="cart-lines">${lines.map(([id,line])=>{const item=data.menu[id];return `<div class="cart-line"><div><b>${esc(item.name)}</b><small>${money(item.price)} cada</small></div><div class="quantity-control"><button data-cart-minus="${id}" aria-label="Diminuir">−</button><b>${line.quantity}</b><button data-cart-add="${id}" aria-label="Aumentar">+</button></div><b>${money(Number(line.quantity)*Number(item.price))}</b></div>`}).join("")||`<p class="muted">Adicione produtos para montar o pedido.</p>`}</div><div class="cart-total"><span>Total</span><b>${money(cartTotal())}</b></div><button class="primary checkout-button" data-open-checkout ${lines.length?'':'disabled'}>Finalizar pedido</button></aside>`;
  return heading("Saídas da adega",lines.length?`<button class="primary" data-open-checkout>Pedido · ${cartQuantity()} itens</button>`:"")+(!open?`<div class="notice"><b>Caixa fechado:</b> vendas diretas exigem abrir o caixa em Admin → Caixa. Ainda é possível finalizar o pedido pela caderneta.</div>`:`<p class="muted">Caixa aberto desde ${date(open[1].opened_at)}.</p>`)+`<div class="sales-layout"><div>${groups}</div>${cartPanel}</div>`;
}
function checkoutDialog(){const lines=cartLines();if(!lines.length)return;const accounts=entries(data.accounts).sort((a,b)=>a[1].customer_name.localeCompare(b[1].customer_name)),hasFood=lines.some(([id])=>category(data.menu[id])==="Comidas"),summary=lines.map(([id,line])=>`<div class="checkout-line"><span>${line.quantity}x ${esc(data.menu[id].name)}</span><b>${money(Number(line.quantity)*Number(data.menu[id].price))}</b></div>`).join("");openModal(`<h2>Finalizar pedido</h2><div class="checkout-summary">${summary}<div class="cart-total"><span>Total</span><b>${money(cartTotal())}</b></div></div>${hasFood?`<div class="notice">Este pedido contém comida e gerará uma única comanda com todos os itens.</div>`:""}<form data-form="checkout"><div class="field"><label>Destino do pedido</label><select name="destination" required><option value="sale">Venda direta</option><option value="account">Adicionar à caderneta</option></select></div><div class="form-row"><div class="field"><label>Cliente</label><input name="customer_name" placeholder="Obrigatório somente para nova caderneta" autofocus></div><div class="field"><label>Pagamento da venda direta</label><select name="payment_method"><option value="">Selecione</option><option>Dinheiro</option><option>Pix</option><option>Cartão</option></select></div></div><div class="field"><label>Caderneta</label><select name="account_id"><option value="">Criar nova caderneta com o cliente informado</option>${accounts.map(([id,a])=>`<option value="${id}">${esc(a.customer_name)}</option>`).join("")}</select></div><div class="field"><label>Observação geral do pedido</label><textarea name="note" placeholder="Ex.: batata sem queijo, entregar na mesa 4..."></textarea></div><button class="primary checkout-button" type="submit">Confirmar pedido · ${money(cartTotal())}</button></form>`)}

function accountsPage(){
  return heading("Caderneta do fiado",`<button class="primary" data-new-account>+ Nova nota</button>`)+`<div class="cards">${entries(data.accounts).sort((a,b)=>a[1].customer_name.localeCompare(b[1].customer_name)).map(([id,a])=>{const total=(a.items||[]).reduce((s,i)=>s+Number(i.quantity)*Number(i.price),0);return `<article class="card"><h3>${esc(a.customer_name)}</h3><p class="muted">${esc(a.note||"Sem observação")}</p><div class="price">${money(total)}</div><div class="card-footer"><span>${a.items?.length||0} registros</span><button data-account="${id}">Abrir conta</button></div></article>`}).join("")||empty("Nenhuma conta aberta.")}</div>`;
}
function accountDialog(id){const a=data.accounts[id];if(!a)return;openModal(`<h2>${esc(a.customer_name)}</h2><p>${esc(a.note||"")}</p><div class="list">${(a.items||[]).map((item,index)=>`<div class="row"><b>${esc(item.description)}</b><span>${Number(item.quantity)} × ${money(item.price)}</span><span>${money(Number(item.quantity)*Number(item.price))}</span><button class="danger" data-delete-account-item="${id}" data-item-id="${item.id||''}" data-index="${index}">Remover</button></div>`).join("")||empty("Nenhum item anotado.")}</div><hr><h3>Adicionar item</h3><form data-form="account-item"><input type="hidden" name="id" value="${id}"><div class="form-row"><div class="field"><label>Item</label><select name="menu_id"><option value="">Manual</option>${entries(data.menu).map(([mid,m])=>`<option value="${mid}">${esc(m.name)} — ${money(m.price)}</option>`).join("")}</select></div><div class="field"><label>Descrição manual</label><input name="description"></div></div><div class="form-row"><div class="field"><label>Quantidade</label><input name="quantity" type="number" value="1" min="1" step="1" inputmode="numeric" required></div><div class="field"><label>Preço manual</label><input name="price" type="number" value="0" min="0" step=".01"></div></div><p class="muted">Itens da categoria Comidas são enviados automaticamente para impressão.</p><button class="primary" type="submit">Adicionar</button></form>`)}

function printOrders(status){return entries(data.kitchen).filter(([,o])=>o.print_status===status).sort((a,b)=>(a[1].created_at||"").localeCompare(b[1].created_at||""))}
function orderItems(o){return Array.isArray(o.items)&&o.items.length?o.items:[{description:o.description,quantity:o.quantity,price:o.price}]}
function ticketMarkup(id,o){const items=orderItems(o);return `<section class="print-ticket" data-ticket-id="${id}"><div class="ticket-brand">ADEGA CAMISA 10</div><div class="ticket-rule"></div><b>COMANDA #${esc(id.slice(0,8).toUpperCase())}</b><div>${date(o.created_at)}</div><div class="ticket-rule"></div><div><b>CLIENTE:</b> ${esc(o.customer_name||"Não informado")}</div><div><b>ORIGEM:</b> ${esc(o.origin||"Balcão")}</div><div class="ticket-items">${items.map(item=>`<div class="ticket-item"><b>${Number(item.quantity)}x ${esc(item.description)}</b></div>`).join("")}</div>${o.note?`<div class="ticket-note"><b>OBS:</b> ${esc(o.note)}</div>`:""}<div class="ticket-rule"></div><small>Impresso pelo Controle da Adega</small></section>`}
function printerRow(id,o,printed=false){const items=orderItems(o),label=items.length===1?`${Number(items[0].quantity)}x ${items[0].description}`:`${items.length} itens · ${items.reduce((sum,item)=>sum+Number(item.quantity),0)} unidades`;return `<div class="row printer-row"><div><b>${esc(label)}</b><div class="muted">${esc(o.customer_name||"Sem cliente")} · ${esc(o.origin||"")}${o.note?` · ${esc(o.note)}`:""}</div></div><span class="status ${printed?'printed':'pending'}">${printed?'Impresso':'Aguardando'}</span><span>${date(printed?o.printed_at:o.created_at)}</span><div class="actions">${printed?`<button data-requeue-print="${id}">Reimprimir</button>`:`<button class="primary" data-test-print="${id}">${printMode==='test'?'Testar comanda':'Imprimir agora'}</button>`}</div></div>`}
function printerPage(){const pending=printOrders("pending"),printed=printOrders("printed").reverse().slice(0,30),legacy=entries(data.kitchen).filter(([,o])=>!o.print_status).length;const modeAction=`<div class="actions"><button data-print-mode="test" class="${printMode==='test'?'nav-active':''}">Modo teste</button><button data-print-mode="automatic" class="${printMode==='automatic'?'nav-active':''}">Automático</button></div>`;return heading("Central de impressão",modeAction)+`<div class="notice">${printMode==='test'?"Modo teste ativo: a janela de impressão será aberta para validar a comanda, sem exigir uma impressora.":"Modo automático ativo: cada nova comanda será enviada à impressora padrão."}</div><div class="metrics"><div class="metric">Aguardando<b>${pending.length}</b></div><div class="metric">Impressas<b>${printed.length}</b></div><div class="metric">Conexão<b>${navigator.onLine?'Online':'Offline'}</b></div></div><h2>Fila de impressão</h2><div class="list">${pending.map(([id,o])=>printerRow(id,o)).join("")||empty("Nenhuma comanda aguardando impressão.")}</div><details><summary>Histórico de impressão</summary><div class="list">${printed.map(([id,o])=>printerRow(id,o,true)).join("")||empty("Nenhuma comanda impressa.")}</div></details>${legacy?`<p class="muted">${legacy} pedidos antigos foram arquivados e não entrarão na fila de impressão.</p>`:""}<div id="printArea">${pending[0]?ticketMarkup(pending[0][0],pending[0][1]):""}</div>`}
async function printOrder(id,mode=printMode){const order=data.kitchen[id];if(!order||printingBusy)return;printingBusy=true;try{const area=document.querySelector("#printArea");if(area)area.innerHTML=ticketMarkup(id,order);await new Promise(resolve=>setTimeout(resolve,50));window.print();await mutate({action:"kitchen.printed",id,mode});draw()}finally{printingBusy=false}}
function queueAutomaticPrint(){if(printMode!=="automatic"||printingBusy)return;const next=printOrders("pending")[0];if(next)setTimeout(()=>printOrder(next[0],"automatic").catch(error=>toast(error.message,true)),400)}

function loginPage(){return `<section class="portal">${heading("Acesso administrativo")}<form data-form="login" class="card" style="max-width:430px"><div class="field"><label>Senha</label><input type="password" name="password" required autofocus></div><button class="primary" type="submit">Entrar</button></form></section>`}
function summaryPage(){
  const all=entries(data.sales),nowDate=new Date(),start=new Date(nowDate),cashOptions=entries(data.cash).sort((a,b)=>(b[1].opened_at||"").localeCompare(a[1].opened_at||""));let sales=all,periodLabel=summaryFilter;
  if(summaryFilter==="Diário")start.setHours(0,0,0,0);
  if(summaryFilter==="Semanal"){start.setHours(0,0,0,0);start.setDate(start.getDate()-((start.getDay()+6)%7))}
  if(summaryFilter==="Mensal"){start.setHours(0,0,0,0);start.setDate(1)}
  if(summaryFilter.startsWith("cash:")){const cashId=summaryFilter.slice(5),cash=cashOptions.find(([id])=>id===cashId);sales=all.filter(([,sale])=>sale.cash_session_id===cashId);periodLabel=cash?`Caixa de ${date(cash[1].opened_at)}`:"Caixa"}
  else sales=all.filter(([,sale])=>new Date(sale.created_at)>=start&&new Date(sale.created_at)<=nowDate);
  const orders=new Map();
  for(const [id,sale] of sales){const key=sale.order_id||id,current=orders.get(key)||{id:key,created_at:sale.created_at,customer_name:sale.customer_name,payment_method:sale.payment_method,note:sale.note,items:[],total:0,quantity:0};current.items.push(sale);current.total+=Number(sale.quantity)*Number(sale.price);current.quantity+=Number(sale.quantity);orders.set(key,current)}
  const orderList=[...orders.values()].sort((a,b)=>(b.created_at||"").localeCompare(a.created_at||"")),revenue=orderList.reduce((sum,order)=>sum+order.total,0),units=orderList.reduce((sum,order)=>sum+order.quantity,0),average=orderList.length?revenue/orderList.length:0;
  const payments=new Map(),products=new Map();
  for(const [,sale] of sales){const method=sale.payment_method||"Não informado";payments.set(method,(payments.get(method)||0)+Number(sale.quantity)*Number(sale.price));const key=sale.description,current=products.get(key)||{name:sale.description,quantity:0,total:0};current.quantity+=Number(sale.quantity);current.total+=Number(sale.quantity)*Number(sale.price);products.set(key,current)}
  const paymentList=[...payments.entries()].sort((a,b)=>b[1]-a[1]),topProducts=[...products.values()].sort((a,b)=>b.quantity-a.quantity||b.total-a.total).slice(0,6),active=activeCash();
  const filters=`<div class="summary-filters"><div class="tabs"><button data-summary="Diário" class="${summaryFilter==="Diário"?'nav-active':''}">Hoje</button><button data-summary="Semanal" class="${summaryFilter==="Semanal"?'nav-active':''}">Semana</button><button data-summary="Mensal" class="${summaryFilter==="Mensal"?'nav-active':''}">Mês</button></div><select data-summary-cash><option value="">Selecionar caixa específico</option>${cashOptions.map(([id,c],index)=>`<option value="cash:${id}" ${summaryFilter===`cash:${id}`?'selected':''}>Caixa ${cashOptions.length-index} · ${date(c.opened_at)}</option>`).join("")}</select></div>`;
  const recent=orderList.slice(0,8).map(order=>`<div class="order-row"><div><b>${esc(order.customer_name||"Venda de balcão")}</b><small>${date(order.created_at)} · ${esc(order.payment_method||"Sem pagamento")}</small></div><span>${order.items.length} ${order.items.length===1?'produto':'produtos'} · ${order.quantity} un.</span><b>${money(order.total)}</b></div>`).join("")||empty("Nenhuma venda neste período.");
  return heading("Visão geral",`<span class="cash-pill ${active?'open':'closed'}">${active?'Caixa aberto':'Caixa fechado'}</span>`)+filters+`<p class="summary-period">Exibindo: <b>${esc(periodLabel)}</b></p><div class="kpi-grid"><article class="kpi-card featured"><span>Faturamento</span><b>${money(revenue)}</b><small>No período selecionado</small></article><article class="kpi-card"><span>Pedidos</span><b>${orderList.length}</b><small>Vendas finalizadas</small></article><article class="kpi-card"><span>Ticket médio</span><b>${money(average)}</b><small>Valor por pedido</small></article><article class="kpi-card"><span>Itens vendidos</span><b>${units}</b><small>Unidades no período</small></article></div><div class="dashboard-grid"><section class="dashboard-card"><div class="dashboard-card-head"><div><span class="eyebrow">Desempenho</span><h2>Mais vendidos</h2></div></div><div class="ranking-list">${topProducts.map((product,index)=>`<div class="ranking-row"><span class="rank">${index+1}</span><div><b>${esc(product.name)}</b><small>${product.quantity} unidades</small></div><b>${money(product.total)}</b></div>`).join("")||empty("Sem produtos no período.")}</div></section><section class="dashboard-card"><div class="dashboard-card-head"><div><span class="eyebrow">Recebimentos</span><h2>Formas de pagamento</h2></div></div><div class="payment-list">${paymentList.map(([method,total])=>`<div class="payment-row"><div><span>${esc(method)}</span><b>${money(total)}</b></div><div class="progress"><i style="width:${revenue?Math.round(total/revenue*100):0}%"></i></div></div>`).join("")||empty("Sem pagamentos no período.")}</div></section></div><section class="dashboard-card recent-orders"><div class="dashboard-card-head"><div><span class="eyebrow">Atividade</span><h2>Pedidos recentes</h2></div><button data-page="adminSales">Ver histórico completo</button></div><div class="order-list">${recent}</div></section>`
}
function salesHistory(withHead=true,source=null){const rows=(source||entries(data.sales)).sort((a,b)=>(b[1].created_at||"").localeCompare(a[1].created_at||""));return (withHead?heading("Saídas registradas"):"")+`<div class="list">${rows.map(([id,s])=>`<div class="row"><div><b>${esc(s.description)}</b><div class="muted">${esc(s.customer_name||"")} ${esc(s.note||"")}</div></div><span>${Number(s.quantity)} × ${money(s.price)}</span><span>${money(Number(s.quantity)*Number(s.price))}</span><span>${date(s.created_at)}</span><button class="danger" data-delete-sale="${id}">Remover</button></div>`).join("")||empty("Nenhuma venda registrada.")}</div>`}
function menuPage(){return heading("Cardápio",`<button class="primary" data-new-menu>+ Cadastrar</button>`)+`<div class="cards">${entries(data.menu).map(([id,m])=>`<article class="card"><h3>${esc(m.name)}</h3><div class="price">${money(m.price)}</div><p class="muted">${category(m)}</p><div class="actions"><button data-edit-menu="${id}">Editar</button><button class="danger" data-delete-menu="${id}">Remover</button></div></article>`).join("")}</div>`}
function menuDialog(id=""){const m=data.menu[id]||{};openModal(`<h2>${id?"Editar":"Cadastrar"} item</h2><form data-form="menu"><input type="hidden" name="id" value="${id}"><div class="field"><label>Nome</label><input name="name" value="${esc(m.name||"")}" required></div><div class="form-row"><div class="field"><label>Preço</label><input name="price" type="number" min="0" step=".01" value="${m.price??0}"></div><div class="field"><label>Categoria</label><select name="category"><option ${category(m)==="Bebidas"?"selected":""}>Bebidas</option><option ${category(m)==="Comidas"?"selected":""}>Comidas</option></select></div></div><button class="primary" type="submit">Salvar</button></form>`)}
function cashPage(){const open=activeCash();const closed=entries(data.cash).filter(([,c])=>c.status==="closed").sort((a,b)=>(b[1].closed_at||"").localeCompare(a[1].closed_at||""));return heading("Controle de caixa",open?`<button class="danger" data-close-cash="${open[0]}">Fechar caixa</button>`:`<button class="primary" data-open-cash>Abrir caixa</button>`)+(open?`<div class="notice">Caixa aberto desde ${date(open[1].opened_at)}</div>`:`<div class="notice">Nenhum caixa aberto.</div>`)+`<h2>Caixas anteriores</h2><div class="list">${closed.map(([,c])=>`<div class="row"><b>${date(c.opened_at)} até ${date(c.closed_at)}</b><span>${c.sales_count||0} vendas</span><span>${c.quantity||0} itens</span><span class="price">${money(c.total)}</span></div>`).join("")||empty("Nenhum caixa fechado.")}</div>`}

document.addEventListener("click",async event=>{
  const el=event.target.closest("button");if(!el)return;
  try{
    if(el.dataset.module){module=el.dataset.module;page=null;draw()}
    else if(el.dataset.page){page=el.dataset.page;draw()}
    else if(el.hasAttribute("data-admin-logout")){token="";sessionStorage.removeItem("adminToken");page=null;draw()}
    else if(el.hasAttribute("data-home")||el.id==="homeBtn"){module=null;page=null;draw()}
    else if(el.hasAttribute("data-close"))closeModal();
    else if(el.dataset.cartAdd)changeCart(el.dataset.cartAdd,1);
    else if(el.dataset.cartMinus)changeCart(el.dataset.cartMinus,-1);
    else if(el.hasAttribute("data-cart-clear")&&confirm("Limpar todos os itens deste pedido?")){cart={};saveCart();draw()}
    else if(el.hasAttribute("data-open-checkout"))checkoutDialog();
    else if(el.hasAttribute("data-new-account"))openModal(`<h2>Nova nota</h2><form data-form="account"><div class="field"><label>Cliente</label><input name="customer_name" required></div><div class="field"><label>Observação</label><textarea name="note"></textarea></div><button class="primary">Adicionar nota</button></form>`);
    else if(el.dataset.account)accountDialog(el.dataset.account);
    else if(el.dataset.deleteAccountItem){await mutate({action:"account.deleteItem",id:el.dataset.deleteAccountItem,item_id:el.dataset.itemId,index:Number(el.dataset.index)});accountDialog(el.dataset.deleteAccountItem)}
    else if(el.dataset.printMode){
      if(el.dataset.printMode==="automatic"&&!confirm("Ativar impressão automática na impressora padrão deste computador?"))return;
      printMode=el.dataset.printMode;localStorage.setItem("printMode",printMode);draw();
    }
    else if(el.dataset.testPrint)await printOrder(el.dataset.testPrint,printMode);
    else if(el.dataset.requeuePrint){await mutate({action:"kitchen.requeue",id:el.dataset.requeuePrint});draw()}
    else if(el.hasAttribute("data-new-menu"))menuDialog();
    else if(el.dataset.editMenu)menuDialog(el.dataset.editMenu);
    else if(el.dataset.deleteMenu&&confirm("Remover este item do cardápio?")){await mutate({action:"menu.delete",id:el.dataset.deleteMenu},true);draw()}
    else if(el.dataset.deleteSale&&confirm("Remover esta venda?")){await mutate({action:"sale.delete",id:el.dataset.deleteSale},true);draw()}
    else if(el.dataset.summary){summaryFilter=el.dataset.summary;draw()}
    else if(el.hasAttribute("data-open-cash")){await mutate({action:"cash.open"},true);draw()}
    else if(el.dataset.closeCash&&confirm("Fechar o caixa atual?")){await mutate({action:"cash.close",id:el.dataset.closeCash},true);draw()}
  }catch(error){toast(error.message,true)}
});

document.addEventListener("submit",async event=>{
  event.preventDefault();const form=event.target;const fd=Object.fromEntries(new FormData(form));
  try{
    if(form.dataset.form==="login"){
      const response=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(fd)});const result=await response.json();if(!response.ok)throw new Error(result.error);token=result.token;sessionStorage.setItem("adminToken",token);page="summary";draw();return;
    }
    if(form.dataset.form==="account")await mutate({action:"account.create",...fd});
    if(form.dataset.form==="menu")await mutate({action:fd.id?"menu.update":"menu.create",...fd},true);
    if(form.dataset.form==="account-item"){
      const item=data.menu[fd.menu_id];await mutate({action:"account.addItem",id:fd.id,description:item?.name||fd.description,price:item?.price??fd.price,quantity:fd.quantity,print_order:Boolean(item&&category(item)==="Comidas")});
    }
    if(form.dataset.form==="checkout"){
      await mutate({action:"sale.checkout",items:cartLines().map(([menu_id,line])=>({menu_id,quantity:line.quantity})),customer_name:fd.customer_name,payment_method:fd.payment_method,note:fd.note,destination:fd.destination,account_id:fd.account_id});
      cart={};saveCart();toast("Pedido finalizado com sucesso.");
    }
    closeModal();draw();
  }catch(error){toast(error.message,true)}
});

document.addEventListener("change",event=>{
  if(event.target.matches("[data-summary-cash]")&&event.target.value){summaryFilter=event.target.value;draw()}
});

modal.addEventListener("click",event=>{if(event.target===modal)closeModal()});
load().catch(error=>{app.innerHTML=empty(error.message)});
