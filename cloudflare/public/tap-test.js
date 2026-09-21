import { tapLink, tapReturn } from './tap-link.mjs';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => Number(value).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
let token = localStorage.getItem('adminToken') || sessionStorage.getItem('adminToken') || '';
let menu = {}, payments = [], selected = {}, draftId = crypto.randomUUID();
const returned = tapReturn(location.search);
// Remove payment details from history; no callback field is trusted as proof of payment.
if (location.search) history.replaceState({}, '', location.pathname);
function message(text, error = false) { $('#message').className = error ? 'error' : 'success'; $('#message').textContent = text; }
async function api(path, payload) {
  const response = await fetch(path, { method: payload ? 'POST' : 'GET', headers: { 'content-type':'application/json', ...(token ? { authorization:`Bearer ${token}` } : {}) }, ...(payload ? {body:JSON.stringify(payload)} : {}) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) { $('#login').hidden = false; $('#workspace').hidden = true; } throw new Error(result.error || 'Não foi possível concluir.'); }
  return result;
}
const mutate = payload => api('/api/mutate', payload);
function products() {
  const query = $('#search').value.toLocaleLowerCase();
  $('#products').innerHTML = Object.entries(menu).filter(([,item]) => item.active !== false && item.name.toLocaleLowerCase().includes(query)).sort((a,b) => a[1].name.localeCompare(b[1].name)).map(([id,item]) => `<div class="product"><label for="qty-${esc(id)}">${esc(item.name)}<small>${money(item.price)}</small></label><input id="qty-${esc(id)}" data-item="${esc(id)}" type="number" min="0" max="999" step="1" inputmode="numeric" value="${selected[id] || 0}" aria-label="Quantidade de ${esc(item.name)}"></div>`).join('') || '<p>Nenhum produto encontrado.</p>';
  $('#total').textContent = money(Object.entries(selected).reduce((sum,[id,q]) => sum + Number(menu[id]?.price || 0) * q, 0));
}
function paymentRows() {
  $('#payments').innerHTML = payments.map(p => {
    const active = p.status === 'pending';
    const ret = returned?.id === p.id && !returned.error ? returned : {};
    return `<article class="payment" id="payment-${esc(p.id)}"><h3>${money(p.total_cents / 100)} · ${p.card_method === 'debit' ? 'Débito' : 'Crédito'}</h3><small>#${esc(p.id.slice(0,8))} · ${esc(new Date(p.created_at).toLocaleString('pt-BR'))} · @${esc(p.handle)}</small><p><b>${active ? 'Aguardando conferência' : p.status === 'recorded' ? 'Venda registrada · conferência manual' : 'Descartada no sistema'}</b></p><ul>${p.items.map(i => `<li>${i.quantity} × ${esc(i.description)}</li>`).join('')}</ul>${active ? `<label class="check"><input type="checkbox" data-ready="${esc(p.id)}">Conferi que este pedido ainda não foi pago. Posso abrir uma cobrança real.</label><a class="launch" data-launch="${esc(p.id)}" href="${esc(tapLink(p, location.origin))}">Abrir InfinitePay · ${money(p.total_cents/100)}</a><small>Se o app não abrir, confira a instalação e permita a abertura de aplicativos neste navegador. Se já pagou, não abra outra cobrança.</small><details><summary>Conferir recebimento e registrar venda</summary><form data-confirm="${esc(p.id)}"><p>Confira na InfinitePay o valor de ${money(p.total_cents/100)}, a conta @${esc(p.handle)} e o comprovante. O retorno do aplicativo não confirma o pagamento automaticamente.</p><label>Identificador da transação (NSU)<input name="nsu" required maxlength="100" value="${esc(ret.nsu || '')}" autocomplete="off"></label><label>Código de autorização<input name="aut" required maxlength="30" value="${esc(ret.aut || '')}" autocomplete="off"></label><label class="check"><input type="checkbox" name="received" required>Conferi na InfinitePay: este pagamento foi aprovado e recebido na conta correta.</label><button>Registrar venda recebida</button></form></details><details><summary>Descartar pedido sem pagamento</summary><form data-cancel="${esc(p.id)}"><label class="check"><input type="checkbox" required>Conferi na InfinitePay que este pedido não foi pago. Descartar não faz estorno.</label><button class="secondary">Descartar pendência</button></form></details>` : ''}</article>`;
  }).join('') || '<p>Nenhuma cobrança preparada ainda.</p>';
}
async function refresh() { payments = (await mutate({action:'tap.list'})).payments; paymentRows(); }
async function load() {
  if (!token) { $('#login').hidden = false; return; }
  const state = await api('/api/state');
  menu = state.menu;
  await refresh();
  $('#login').hidden = true; $('#workspace').hidden = false;
  $('#order-form').handle.value = localStorage.getItem('tapHandle') || '';
  products();
  if (returned) message(returned.error || 'Você voltou da cobrança. Confira o pagamento na InfinitePay e registre o recebimento abaixo.', Boolean(returned.error));
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { const result = await api('/api/login', {password:event.target.password.value}); token = result.token; sessionStorage.setItem('adminToken',token); event.target.reset(); await load(); }
  catch(error) { message(error.message,true); } finally { button.disabled = false; }
});
$('#search').addEventListener('input', products);
$('#products').addEventListener('input', event => {
  if (!event.target.dataset.item) return;
  const q = Number(event.target.value);
  if (!Number.isInteger(q) || q < 0 || q > 999) return;
  selected[event.target.dataset.item] = q;
  $('#total').textContent = money(Object.entries(selected).reduce((sum,[id,n]) => sum + Number(menu[id]?.price || 0) * n, 0));
  draftId = crypto.randomUUID();
});
$('#order-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#prepare'); button.disabled = true;
  try {
    const form = event.target;
    const result = await mutate({action:'tap.prepare',id:draftId,handle:form.handle.value,card_method:form.card_method.value,customer_name:form.customer_name.value,items:Object.entries(selected).filter(([,q])=>q>0).map(([menu_id,quantity])=>({menu_id,quantity}))});
    localStorage.setItem('tapHandle', result.payment.handle);
    selected = {}; draftId = crypto.randomUUID(); products(); await refresh();
    message('Pedido guardado. Na cobrança abaixo, confira a conta e toque em Abrir InfinitePay.');
    document.getElementById(`payment-${result.id}`)?.scrollIntoView({behavior:'smooth'});
  } catch(error) { message(error.message,true); } finally { button.disabled = false; }
});
$('#payments').addEventListener('click', event => {
  const link = event.target.closest('[data-launch]'); if (!link) return;
  const ready = [...document.querySelectorAll('[data-ready]')].find(el => el.dataset.ready === link.dataset.launch);
  if (!ready?.checked) { event.preventDefault(); message('Confira se o pedido já foi pago antes de abrir a cobrança.',true); return; }
  ready.checked = false;
  message('Conclua no InfinitePay. Se não retornar automaticamente, volte a esta página pelo navegador.');
});
$('#payments').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, button = form.querySelector('button'); button.disabled = true;
  try {
    if (form.dataset.confirm) await mutate({action:'tap.confirm',id:form.dataset.confirm,confirmed_received:form.received.checked,nsu:form.nsu.value,aut:form.aut.value});
    else await mutate({action:'tap.cancel',id:form.dataset.cancel,confirmed_unpaid:true});
    await refresh(); message(form.dataset.confirm ? 'Venda registrada no caixa e no estoque. Não cobre este pedido novamente.' : 'Pendência descartada. Nenhum estorno foi solicitado.');
  } catch(error) { message(error.message,true); } finally { button.disabled = false; }
});
$('#refresh').addEventListener('click', () => refresh().catch(error => message(error.message,true)));
load().catch(error => message(error.message,true));
