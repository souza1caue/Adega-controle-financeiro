const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const KINDS = ["menu", "accounts", "account_payments", "sales", "kitchen", "cash"];

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readRecord(db, kind, id) {
  const row = await db.prepare("SELECT data FROM records WHERE kind=? AND id=?").bind(kind, id).first();
  return row ? JSON.parse(row.data) : null;
}

function putRecord(db, kind, id, data) {
  return db.prepare(`INSERT INTO records(kind,id,data,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=CURRENT_TIMESTAMP`)
    .bind(kind, id, JSON.stringify(data));
}

async function state(db) {
  const rows = await db.prepare("SELECT kind,id,data FROM records ORDER BY created_at").all();
  const result = Object.fromEntries(KINDS.map((kind) => [kind, {}]));
  for (const row of rows.results) if (result[row.kind]) result[row.kind][row.id] = JSON.parse(row.data);
  return result;
}

async function isAdmin(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  const tokenHash = await sha256(`${token}:${env.SESSION_SECRET}`);
  const row = await env.DB.prepare("SELECT 1 ok FROM sessions WHERE token_hash=? AND expires_at>CURRENT_TIMESTAMP")
    .bind(tokenHash).first();
  return Boolean(row?.ok);
}

async function login(request, env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return reply({ error: "Segredos administrativos não configurados." }, 503);
  const { password = "" } = await request.json();
  if ((await sha256(password)) !== (await sha256(env.ADMIN_PASSWORD))) return reply({ error: "Senha inválida." }, 401);
  const token = `${uid()}${uid()}`;
  const tokenHash = await sha256(`${token}:${env.SESSION_SECRET}`);
  const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<=CURRENT_TIMESTAMP"),
    env.DB.prepare("INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)").bind(tokenHash, expires),
  ]);
  return reply({ token, expires });
}

function required(value, label) {
  if (!String(value ?? "").trim()) throw new Error(`Informe ${label}.`);
}

function quantity(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Informe uma quantidade inteira maior que zero.");
  return parsed;
}

function amount(value, label, allowZero = true) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) throw new Error(`Informe ${label} válido.`);
  return Math.round(parsed * 100) / 100;
}

function accountBalance(account) {
  const charges = (account.items || []).filter((item) => !item.cancelled_at)
    .reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.price || 0), 0);
  return Math.max(0, Math.round((charges - Number(account.payments_total || 0)) * 100) / 100);
}

function isFood(item) {
  return item.category === "Comidas" || /por[cç][aã]o|batata|carne|frango|lanche|comida/i.test(item.name || "");
}

async function cartItems(db, inputItems) {
  if (!Array.isArray(inputItems) || !inputItems.length) throw new Error("Adicione itens ao pedido.");
  if (inputItems.length > 30) throw new Error("O pedido excedeu o limite de 30 itens diferentes.");
  const result = [];
  for (const inputItem of inputItems) {
    const menuItem = await readRecord(db, "menu", inputItem.menu_id);
    if (!menuItem) throw new Error("Um item do pedido não está mais disponível no cardápio.");
    result.push({
      menu_id: inputItem.menu_id,
      description: menuItem.name,
      quantity: quantity(inputItem.quantity),
      price: Number(menuItem.price),
      category: isFood(menuItem) ? "Comidas" : "Bebidas",
      note: (inputItem.note || "").trim(),
    });
  }
  return result;
}

async function mutate(request, env) {
  const input = await request.json();
  const action = input.action;
  const adminActions = new Set(["menu.create", "menu.update", "menu.delete", "sale.delete", "sale.void", "cash.open", "cash.movement", "cash.close"]);
  if (adminActions.has(action) && !(await isAdmin(request, env))) return reply({ error: "Acesso administrativo necessário." }, 401);
  const db = env.DB;
  const id = input.id || uid();

  if (action === "menu.create" || action === "menu.update") {
    required(input.name, "o nome do item");
    const item = { ...(action === "menu.update" ? await readRecord(db, "menu", id) : {}), name: input.name.trim(), price: Number(input.price), category: input.category === "Comidas" ? "Comidas" : "Bebidas" };
    item[action === "menu.create" ? "created_at" : "updated_at"] = now();
    await putRecord(db, "menu", id, item).run();
  } else if (action === "menu.delete") {
    await db.prepare("DELETE FROM records WHERE kind='menu' AND id=?").bind(id).run();
  } else if (action === "account.create") {
    required(input.customer_name, "o nome do cliente");
    await putRecord(db, "accounts", id, { customer_name: input.customer_name.trim(), note: (input.note || "").trim(), created_at: now().slice(0, 10), items: [], payments_total: 0 }).run();
  } else if (action === "account.addItem") {
    const account = await readRecord(db, "accounts", id);
    if (!account) throw new Error("Conta não encontrada.");
    required(input.description, "o item");
    const createdAt = now();
    const orderId = uid();
    const entry = { id: uid(), description: input.description.trim(), quantity: quantity(input.quantity), price: amount(input.price, "o preço"), created_at: createdAt, order_id: orderId };
    account.items = [...(account.items || []), entry];
    const statements = [
      putRecord(db, "accounts", id, account),
      putRecord(db, "sales", uid(), { description: entry.description, quantity: entry.quantity, price: entry.price, customer_name: account.customer_name, payment_method: "Caderneta", account_id: id, account_item_id: entry.id, order_id: orderId, created_at: createdAt }),
    ];
    if (input.print_order || input.send_to_kitchen) statements.push(putRecord(db, "kitchen", uid(), { ...entry, customer_name: account.customer_name, note: (input.note || "").trim(), origin: "Caderneta", print_status: "pending", print_count: 0 }));
    await db.batch(statements);
  } else if (action === "account.cancelItem") {
    const account = await readRecord(db, "accounts", id);
    if (!account) throw new Error("Conta não encontrada.");
    required(input.reason, "o motivo do cancelamento");
    required(input.responsible, "o responsável pelo cancelamento");
    const item = (account.items || []).find((entry, index) => entry.id ? entry.id === input.item_id : index === Number(input.index));
    if (!item) throw new Error("Item não encontrado.");
    if (item.cancelled_at) throw new Error("Este item já foi cancelado.");
    const itemTotal = Number(item.quantity || 0) * Number(item.price || 0);
    if (itemTotal > accountBalance(account) + 0.001) throw new Error("Não é possível cancelar um consumo que já foi recebido.");
    item.cancelled_at = now(); item.cancel_reason = input.reason.trim(); item.cancelled_by = input.responsible.trim();
    const statements = [putRecord(db, "accounts", id, account)];
    if (item.id) {
      const related = await db.prepare("SELECT id,data FROM records WHERE kind='sales' AND json_extract(data,'$.account_item_id')=?").bind(item.id).all();
      for (const row of related.results) {
        const sale = JSON.parse(row.data);
        sale.voided_at = item.cancelled_at; sale.void_reason = item.cancel_reason; sale.voided_by = item.cancelled_by;
        statements.push(putRecord(db, "sales", row.id, sale));
      }
    }
    await db.batch(statements);
  } else if (action === "account.receivePayment") {
    const account = await readRecord(db, "accounts", id);
    if (!account) throw new Error("Conta não encontrada.");
    const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
    if (!open) throw new Error("Abra o caixa antes de receber uma caderneta.");
    required(input.payment_method, "a forma de pagamento");
    if (!["Dinheiro", "Pix", "Cartão"].includes(input.payment_method)) throw new Error("Forma de pagamento inválida.");
    required(input.responsible, "o responsável pelo recebimento");
    const received = amount(input.amount, "um valor", false);
    const balance = accountBalance(account);
    if (received > balance + 0.001) throw new Error(`O valor informado é maior que o saldo de R$ ${balance.toFixed(2).replace('.', ',')}.`);
    const paymentId = uid();
    const createdAt = now();
    const payment = { account_id: id, customer_name: account.customer_name, amount: received, payment_method: input.payment_method, responsible: input.responsible.trim(), note: (input.note || "").trim(), cash_session_id: open.id, created_at: createdAt };
    account.payments_total = Math.round((Number(account.payments_total || 0) + received) * 100) / 100;
    account.last_payment_at = createdAt;
    await db.batch([putRecord(db, "accounts", id, account), putRecord(db, "account_payments", paymentId, payment)]);
  } else if (action === "sale.checkout") {
    const items = await cartItems(db, input.items);
    const createdAt = now();
    const customerName = (input.customer_name || "").trim();
    const note = (input.note || "").trim();
    const statements = [];
    const foodItems = items.filter((item) => item.category === "Comidas");
    const shouldPrint = foodItems.length > 0;
    const orderId = id;

    if (input.destination === "account" || input.to_account === true) {
      const accountId = input.account_id || uid();
      let account = await readRecord(db, "accounts", accountId);
      if (!account) {
        required(customerName, "o cliente para criar a caderneta");
        account = { customer_name: customerName, note: "", created_at: createdAt.slice(0, 10), items: [], payments_total: 0 };
      }
      const accountEntries = items.map((item) => ({ id: uid(), description: item.description, quantity: item.quantity, price: item.price, note: item.note, created_at: createdAt, order_id: orderId }));
      account.items = [...(account.items || []), ...accountEntries];
      statements.push(putRecord(db, "accounts", accountId, account));
      for (const entry of accountEntries) statements.push(putRecord(db, "sales", uid(), { description: entry.description, quantity: entry.quantity, price: entry.price, item_note: entry.note, note, customer_name: account.customer_name, payment_method: "Caderneta", account_id: accountId, account_item_id: entry.id, order_id: orderId, created_at: createdAt }));
      if (shouldPrint) statements.push(putRecord(db, "kitchen", orderId, { items: foodItems, description: `${foodItems.length} itens`, quantity: foodItems.reduce((sum, item) => sum + item.quantity, 0), customer_name: account.customer_name, note, origin: "Caderneta", created_at: createdAt, print_status: "pending", print_count: 0 }));
    } else {
      const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
      if (!open) throw new Error("Abra o caixa no Admin antes de registrar a venda direta.");
      required(input.payment_method, "a forma de pagamento");
      for (const item of items) {
        const saleId = uid();
        statements.push(putRecord(db, "sales", saleId, { description: item.description, quantity: item.quantity, price: item.price, item_note: item.note, note, customer_name: customerName, payment_method: input.payment_method, cash_session_id: open.id, order_id: orderId, created_at: createdAt }));
      }
      if (shouldPrint) statements.push(putRecord(db, "kitchen", orderId, { items: foodItems, description: `${foodItems.length} itens`, quantity: foodItems.reduce((sum, item) => sum + item.quantity, 0), customer_name: customerName, note, origin: "Venda", payment_method: input.payment_method, created_at: createdAt, print_status: "pending", print_count: 0 }));
    }
    await db.batch(statements);
  } else if (action === "sale.create") {
    const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
    if (!open) throw new Error("Abra o caixa no Admin antes de registrar saídas.");
    required(input.description, "o item");
    required(input.payment_method, "a forma de pagamento");
    const sale = { description: input.description.trim(), quantity: quantity(input.quantity), price: Number(input.price), payment_method: input.payment_method, note: (input.note || "").trim(), customer_name: (input.customer_name || "").trim(), cash_session_id: open.id, created_at: now() };
    const statements = [putRecord(db, "sales", id, sale)];
    if (input.print_order || input.send_to_kitchen) {
      statements.push(putRecord(db, "kitchen", uid(), { ...sale, origin: "Venda", print_status: "pending", print_count: 0 }));
    }
    await db.batch(statements);
  } else if (action === "sale.delete") {
    await db.prepare("DELETE FROM records WHERE kind='sales' AND id=?").bind(id).run();
  } else if (action === "sale.void") {
    required(input.reason, "a justificativa do cancelamento");
    const sale = await readRecord(db, "sales", id);
    if (!sale) throw new Error("Lançamento não encontrado.");
    if (sale.voided_at) throw new Error("Este lançamento já foi cancelado.");
    sale.voided_at = now();
    sale.void_reason = input.reason.trim();
    sale.voided_by = (input.responsible || "Admin").trim();
    await putRecord(db, "sales", id, sale).run();
  } else if (action === "kitchen.printed") {
    const order = await readRecord(db, "kitchen", id);
    if (!order) throw new Error("Pedido não encontrado.");
    if (!order.print_status) throw new Error("Pedido anterior ao sistema de impressão.");
    order.print_status = "printed";
    order.printed_at = now();
    order.print_count = Number(order.print_count || 0) + 1;
    order.last_print_mode = input.mode === "automatic" ? "automatic" : "test";
    await putRecord(db, "kitchen", id, order).run();
  } else if (action === "kitchen.requeue") {
    const order = await readRecord(db, "kitchen", id);
    if (!order) throw new Error("Pedido não encontrado.");
    if (!order.print_status) throw new Error("Pedido anterior ao sistema de impressão.");
    order.print_status = "pending";
    order.requeued_at = now();
    await putRecord(db, "kitchen", id, order).run();
  } else if (action === "cash.open") {
    required(input.opened_by, "o responsável pela abertura");
    const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' LIMIT 1").first();
    if (open) throw new Error("Já existe um caixa aberto.");
    await putRecord(db, "cash", id, { status: "open", opened_at: now(), opened_by: input.opened_by.trim(), opening_amount: amount(input.opening_amount, "o valor inicial"), opening_note: (input.note || "").trim(), movements: [], closed_at: "" }).run();
  } else if (action === "cash.movement") {
    const cash = await readRecord(db, "cash", id);
    if (!cash || cash.status !== "open") throw new Error("Caixa aberto não encontrado.");
    if (!['supply', 'withdrawal'].includes(input.type)) throw new Error("Tipo de movimentação inválido.");
    required(input.responsible, "o responsável pela movimentação");
    required(input.note, "o motivo da movimentação");
    cash.movements = [...(cash.movements || []), { id: uid(), type: input.type, amount: amount(input.amount, "um valor", false), responsible: input.responsible.trim(), note: input.note.trim(), created_at: now() }];
    await putRecord(db, "cash", id, cash).run();
  } else if (action === "cash.close") {
    const cash = await readRecord(db, "cash", id);
    if (!cash || cash.status !== "open") throw new Error("Caixa aberto não encontrado.");
    required(input.closed_by, "o responsável pelo fechamento");
    const sales = await db.prepare("SELECT data FROM records WHERE kind='sales' AND json_extract(data,'$.cash_session_id')=?").bind(id).all();
    const parsed = sales.results.map((row) => JSON.parse(row.data)).filter((sale) => !sale.voided_at);
    const paymentTotals = {};
    for (const sale of parsed) paymentTotals[sale.payment_method || "Não informado"] = (paymentTotals[sale.payment_method || "Não informado"] || 0) + Number(sale.quantity || 0) * Number(sale.price || 0);
    const receiptRows = await db.prepare("SELECT data FROM records WHERE kind='account_payments' AND json_extract(data,'$.cash_session_id')=?").bind(id).all();
    const receipts = receiptRows.results.map((row) => JSON.parse(row.data)).filter((payment) => !payment.voided_at);
    for (const payment of receipts) paymentTotals[payment.payment_method] = (paymentTotals[payment.payment_method] || 0) + Number(payment.amount || 0);
    const supplies = (cash.movements || []).filter((movement) => movement.type === 'supply').reduce((sum, movement) => sum + Number(movement.amount || 0), 0);
    const withdrawals = (cash.movements || []).filter((movement) => movement.type === 'withdrawal').reduce((sum, movement) => sum + Number(movement.amount || 0), 0);
    const expectedCash = Number(cash.opening_amount || 0) + Number(paymentTotals.Dinheiro || 0) + supplies - withdrawals;
    const countedCash = amount(input.counted_cash, "o dinheiro contado");
    cash.status = "closed"; cash.closed_at = now(); cash.closed_by = input.closed_by.trim(); cash.closing_note = (input.note || "").trim(); cash.sales_count = new Set(parsed.map((sale) => sale.order_id || sale.created_at)).size; cash.account_payments_count = receipts.length;
    cash.quantity = parsed.reduce((sum, sale) => sum + Number(sale.quantity || 0), 0);
    cash.total = parsed.reduce((sum, sale) => sum + Number(sale.quantity || 0) * Number(sale.price || 0), 0) + receipts.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    cash.payment_totals = paymentTotals; cash.supplies_total = supplies; cash.withdrawals_total = withdrawals; cash.expected_cash = expectedCash; cash.counted_cash = countedCash; cash.difference = countedCash - expectedCash;
    const grouped = new Map();
    for (const sale of parsed) {
      const key = sale.description.trim().toLocaleLowerCase();
      const current = grouped.get(key) || { description: sale.description.trim(), quantity: 0, total: 0 };
      current.quantity += Number(sale.quantity || 0);
      current.total += Number(sale.quantity || 0) * Number(sale.price || 0);
      grouped.set(key, current);
    }
    cash.items = [...grouped.values()].sort((a, b) => a.description.localeCompare(b.description));
    await putRecord(db, "cash", id, cash).run();
  } else throw new Error("Ação desconhecida.");
  return reply({ ok: true, id });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/state" && request.method === "GET") return reply(await state(env.DB));
      if (url.pathname === "/api/login" && request.method === "POST") return await login(request, env);
      if (url.pathname === "/api/mutate" && request.method === "POST") return await mutate(request, env);
      if (url.pathname.startsWith("/api/")) return reply({ error: "Rota não encontrada." }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return reply({ error: error.message || "Erro interno." }, 400);
    }
  },
};
