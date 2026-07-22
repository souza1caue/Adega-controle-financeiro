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

const esc = (v="") => String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = value => Number(value||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});
const date = value => value ? new Date(`${value}${value.length===10?'T12:00':''}`).toLocaleString("pt-BR",{dateStyle:"short",timeStyle:value.length>10?"short":undefined}) : "—";
const entries = object => Object.entries(object||{});
const activeCash = () => entries(data.cash).sort((a,b)=>(b[1].opened_at||"").localeCompare(a[1].opened_at||"")).find(([,c])=>c.status==="open");
const category = item => item.category || (/por[cç][aã]o|batata|carne|frango|lanche|comida/i.test(item.name)?"Comidas":"Bebidas");
const statusName = {pending:"Pendente",started:"Em andamento",ready:"Pronto",delivered:"Entregue",done:"Concluído"};

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
    page ||= "summary";setupNav([["summary","Resumo"],["menu","Cardápio"],["cash","Caixa"],["adminSales","Saídas"],["accounts","Fiado"],["adminPrinter","Impressora"]]);
    app.innerHTML=page==="summary"?summaryPage():page==="menu"?menuPage():page==="cash"?cashPage():page==="adminSales"?salesHistory():page==="accounts"?accountsPage():printerPage();
    if(page==="adminPrinter"){refreshTimer=setInterval(()=>load(true).catch(()=>{}),3000);queueAutomaticPrint()}
  }
}

function salesPage(){
  const open=activeCash();
  const groups=["Bebidas","Comidas"].map(cat=>`<h2>${cat}</h2><div class="cards">${entries(data.menu).filter(([,item])=>category(item)===cat).sort((a,b)=>a[1].name.localeCompare(b[1].name)).map(([id,item])=>`<article class="card"><h3>${esc(item.name)}</h3><div class="price">${money(item.price)}</div><div class="card-footer"><span class="muted">${cat}</span><button class="primary" data-sale-item="${id}">Adicionar</button></div></article>`).join("")||empty(`Nenhum item em ${cat.toLowerCase()}.`)}</div>`).join("");
  return heading("Saídas da adega")+(!open?`<div class="notice">Caixa fechado. Abra o caixa no módulo Admin antes de registrar vendas.</div>`:`<p class="muted">Caixa aberto desde ${date(open[1].opened_at)}.</p>`)+groups;
}
function saleDialog(id){const item=data.menu[id];if(!item)return;const accounts=entries(data.accounts);openModal(`<h2>${esc(item.name)}</h2><p class="price">${money(item.price)}</p><form data-form="sale"><input type="hidden" name="menu_id" value="${id}"><div class="form-row"><div class="field"><label>Quantidade</label><input name="quantity" type="number" min="0.01" step="1" value="1" required></div><div class="field"><label>Pagamento</label><select name="payment_method"><option value="">Selecione</option><option>Dinheiro</option><option>Pix</option><option>Cartão</option></select></div></div><div class="field"><label>Observação</label><input name="note"></div><label><input name="send_to_kitchen" type="checkbox" style="width:auto"> Imprimir comanda</label><div class="field"><label>Cliente do pedido</label><input name="customer_name"></div><label><input name="send_to_account" type="checkbox" style="width:auto"> Enviar para caderneta</label><div class="field"><label>Conta existente</label><select name="account_id"><option value="">Nova conta</option>${accounts.map(([aid,a])=>`<option value="${aid}">${esc(a.customer_name)}</option>`).join("")}</select></div><div class="actions"><button class="primary" type="submit">Adicionar</button></div></form>`)}

function accountsPage(){
  return heading("Caderneta do fiado",`<button class="primary" data-new-account>+ Nova nota</button>`)+`<div class="cards">${entries(data.accounts).sort((a,b)=>a[1].customer_name.localeCompare(b[1].customer_name)).map(([id,a])=>{const total=(a.items||[]).reduce((s,i)=>s+Number(i.quantity)*Number(i.price),0);return `<article class="card"><h3>${esc(a.customer_name)}</h3><p class="muted">${esc(a.note||"Sem observação")}</p><div class="price">${money(total)}</div><div class="card-footer"><span>${a.items?.length||0} registros</span><button data-account="${id}">Abrir conta</button></div></article>`}).join("")||empty("Nenhuma conta aberta.")}</div>`;
}
function accountDialog(id){const a=data.accounts[id];if(!a)return;openModal(`<h2>${esc(a.customer_name)}</h2><p>${esc(a.note||"")}</p><div class="list">${(a.items||[]).map((item,index)=>`<div class="row"><b>${esc(item.description)}</b><span>${Number(item.quantity)} × ${money(item.price)}</span><span>${money(Number(item.quantity)*Number(item.price))}</span><button class="danger" data-delete-account-item="${id}" data-item-id="${item.id||''}" data-index="${index}">Remover</button></div>`).join("")||empty("Nenhum item anotado.")}</div><hr><h3>Adicionar item</h3><form data-form="account-item"><input type="hidden" name="id" value="${id}"><div class="form-row"><div class="field"><label>Item</label><select name="menu_id"><option value="">Manual</option>${entries(data.menu).map(([mid,m])=>`<option value="${mid}">${esc(m.name)} — ${money(m.price)}</option>`).join("")}</select></div><div class="field"><label>Descrição manual</label><input name="description"></div></div><div class="form-row"><div class="field"><label>Quantidade</label><input name="quantity" type="number" value="1" min=".01" step="1"></div><div class="field"><label>Preço manual</label><input name="price" type="number" value="0" min="0" step=".01"></div></div><label><input name="send_to_kitchen" type="checkbox" style="width:auto"> Imprimir comanda</label><button class="primary" type="submit">Adicionar</button></form>`)}

function printOrders(status){return entries(data.kitchen).filter(([,o])=>o.print_status===status).sort((a,b)=>(a[1].created_at||"").localeCompare(b[1].created_at||""))}
function ticketMarkup(id,o){return `<section class="print-ticket" data-ticket-id="${id}"><div class="ticket-brand">ADEGA CAMISA 10</div><div class="ticket-rule"></div><b>COMANDA #${esc(id.slice(0,8).toUpperCase())}</b><div>${date(o.created_at)}</div><div class="ticket-rule"></div><div><b>CLIENTE:</b> ${esc(o.customer_name||"Não informado")}</div><div><b>ORIGEM:</b> ${esc(o.origin||"Balcão")}</div><div class="ticket-item"><b>${Number(o.quantity)}x ${esc(o.description)}</b></div>${o.note?`<div class="ticket-note"><b>OBS:</b> ${esc(o.note)}</div>`:""}<div class="ticket-rule"></div><small>Impresso pelo Controle da Adega</small></section>`}
function printerRow(id,o,printed=false){return `<div class="row printer-row"><div><b>${Number(o.quantity)}x ${esc(o.description)}</b><div class="muted">${esc(o.customer_name||"Sem cliente")} · ${esc(o.origin||"")}${o.note?` · ${esc(o.note)}`:""}</div></div><span class="status ${printed?'printed':'pending'}">${printed?'Impresso':'Aguardando'}</span><span>${date(printed?o.printed_at:o.created_at)}</span><div class="actions">${printed?`<button data-requeue-print="${id}">Reimprimir</button>`:`<button class="primary" data-test-print="${id}">${printMode==='test'?'Testar comanda':'Imprimir agora'}</button>`}</div></div>`}
function printerPage(){const pending=printOrders("pending"),printed=printOrders("printed").reverse().slice(0,30),legacy=entries(data.kitchen).filter(([,o])=>!o.print_status).length;const modeAction=`<div class="actions"><button data-print-mode="test" class="${printMode==='test'?'nav-active':''}">Modo teste</button><button data-print-mode="automatic" class="${printMode==='automatic'?'nav-active':''}">Automático</button></div>`;return heading("Central de impressão",modeAction)+`<div class="notice">${printMode==='test'?"Modo teste ativo: a janela de impressão será aberta para validar a comanda, sem exigir uma impressora.":"Modo automático ativo: cada nova comanda será enviada à impressora padrão."}</div><div class="metrics"><div class="metric">Aguardando<b>${pending.length}</b></div><div class="metric">Impressas<b>${printed.length}</b></div><div class="metric">Conexão<b>${navigator.onLine?'Online':'Offline'}</b></div></div><h2>Fila de impressão</h2><div class="list">${pending.map(([id,o])=>printerRow(id,o)).join("")||empty("Nenhuma comanda aguardando impressão.")}</div><details><summary>Histórico de impressão</summary><div class="list">${printed.map(([id,o])=>printerRow(id,o,true)).join("")||empty("Nenhuma comanda impressa.")}</div></details>${legacy?`<p class="muted">${legacy} pedidos antigos foram arquivados e não entrarão na fila de impressão.</p>`:""}<div id="printArea">${pending[0]?ticketMarkup(pending[0][0],pending[0][1]):""}</div>`}
async function printOrder(id,mode=printMode){const order=data.kitchen[id];if(!order||printingBusy)return;printingBusy=true;try{const area=document.querySelector("#printArea");if(area)area.innerHTML=ticketMarkup(id,order);await new Promise(resolve=>setTimeout(resolve,50));window.print();await mutate({action:"kitchen.printed",id,mode});draw()}finally{printingBusy=false}}
function queueAutomaticPrint(){if(printMode!=="automatic"||printingBusy)return;const next=printOrders("pending")[0];if(next)setTimeout(()=>printOrder(next[0],"automatic").catch(error=>toast(error.message,true)),400)}

function loginPage(){return `<section class="portal">${heading("Acesso administrativo")}<form data-form="login" class="card" style="max-width:430px"><div class="field"><label>Senha</label><input type="password" name="password" required autofocus></div><button class="primary" type="submit">Entrar</button></form></section>`}
function summaryPage(){
  const all=entries(data.sales), nowDate=new Date(), start=new Date(nowDate); let label=summaryFilter.toLowerCase(), sales=all;
  if(summaryFilter==="Diário") start.setHours(0,0,0,0);
  if(summaryFilter==="Semanal"){start.setHours(0,0,0,0);start.setDate(start.getDate()-((start.getDay()+6)%7))}
  if(summaryFilter==="Mensal"){start.setHours(0,0,0,0);start.setDate(1)}
  if(summaryFilter.startsWith("cash:")){const id=summaryFilter.slice(5);sales=all.filter(([,s])=>s.cash_session_id===id);label="caixa"}
  else sales=all.filter(([,s])=>new Date(s.created_at)>=start&&new Date(s.created_at)<=nowDate);
  const total=sales.reduce((s,[,v])=>s+Number(v.quantity)*Number(v.price),0), qty=sales.reduce((s,[,v])=>s+Number(v.quantity),0), general=all.reduce((s,[,v])=>s+Number(v.quantity)*Number(v.price),0);
  const cashOptions=entries(data.cash).sort((a,b)=>(b[1].opened_at||"").localeCompare(a[1].opened_at||""));
  return heading("Resumo de vendas")+`<div class="tabs"><button data-summary="Diário" class="${summaryFilter==="Diário"?'nav-active':''}">Diário</button><button data-summary="Semanal" class="${summaryFilter==="Semanal"?'nav-active':''}">Semanal</button><button data-summary="Mensal" class="${summaryFilter==="Mensal"?'nav-active':''}">Mensal</button>${cashOptions.map(([id,c],i)=>`<button data-summary="cash:${id}" class="${summaryFilter===`cash:${id}`?'nav-active':''}">Caixa ${i+1} · ${date(c.opened_at)}</button>`).join("")}</div><div class="metrics"><div class="metric">Total ${label}<b>${money(total)}</b></div><div class="metric">Itens ${label}<b>${qty}</b></div><div class="metric">Total geral<b>${money(general)}</b></div></div><h2>Saídas do resumo</h2>${salesHistory(false,sales)}`
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
    else if(el.hasAttribute("data-home")||el.id==="homeBtn"){module=null;page=null;draw()}
    else if(el.hasAttribute("data-close"))closeModal();
    else if(el.dataset.saleItem)saleDialog(el.dataset.saleItem);
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
      const item=data.menu[fd.menu_id];await mutate({action:"account.addItem",id:fd.id,description:item?.name||fd.description,price:item?.price??fd.price,quantity:fd.quantity,send_to_kitchen:form.send_to_kitchen.checked});
    }
    if(form.dataset.form==="sale"){
      const item=data.menu[fd.menu_id];
      if(form.send_to_account.checked){let aid=fd.account_id;if(!aid){if(!fd.customer_name)throw new Error("Informe o cliente da caderneta.");aid=(await mutate({action:"account.create",customer_name:fd.customer_name,note:""})).id}await mutate({action:"account.addItem",id:aid,description:item.name,price:item.price,quantity:fd.quantity,send_to_kitchen:form.send_to_kitchen.checked,note:fd.note});}
      else await mutate({action:"sale.create",description:item.name,price:item.price,quantity:fd.quantity,payment_method:fd.payment_method,note:fd.note,customer_name:fd.customer_name,send_to_kitchen:form.send_to_kitchen.checked});
    }
    closeModal();draw();
  }catch(error){toast(error.message,true)}
});

modal.addEventListener("click",event=>{if(event.target===modal)closeModal()});
load().catch(error=>{app.innerHTML=empty(error.message)});
