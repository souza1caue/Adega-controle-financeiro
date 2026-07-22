const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const KINDS = ["menu", "accounts", "sales", "kitchen", "cash"];

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
    });
  }
  return result;
}

async function mutate(request, env) {
  const input = await request.json();
  const action = input.action;
  const adminActions = new Set(["menu.create", "menu.update", "menu.delete", "sale.delete", "cash.open", "cash.close"]);
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
    await putRecord(db, "accounts", id, { customer_name: input.customer_name.trim(), note: (input.note || "").trim(), created_at: now().slice(0, 10), items: [] }).run();
  } else if (action === "account.addItem") {
    const account = await readRecord(db, "accounts", id);
    if (!account) throw new Error("Conta não encontrada.");
    required(input.description, "o item");
    const entry = { id: uid(), description: input.description.trim(), quantity: quantity(input.quantity), price: Number(input.price), created_at: now() };
    account.items = [...(account.items || []), entry];
    const statements = [putRecord(db, "accounts", id, account)];
    if (input.print_order || input.send_to_kitchen) statements.push(putRecord(db, "kitchen", uid(), { ...entry, customer_name: account.customer_name, note: (input.note || "").trim(), origin: "Caderneta", print_status: "pending", print_count: 0 }));
    await db.batch(statements);
  } else if (action === "account.deleteItem") {
    const account = await readRecord(db, "accounts", id);
    if (!account) throw new Error("Conta não encontrada.");
    account.items = (account.items || []).filter((item, index) => item.id ? item.id !== input.item_id : index !== Number(input.index));
    await putRecord(db, "accounts", id, account).run();
  } else if (action === "sale.checkout") {
    const items = await cartItems(db, input.items);
    const createdAt = now();
    const customerName = (input.customer_name || "").trim();
    const note = (input.note || "").trim();
    const statements = [];
    const shouldPrint = items.some((item) => item.category === "Comidas");
    const orderId = id;

    if (input.destination === "account" || input.to_account === true) {
      const accountId = input.account_id || uid();
      let account = await readRecord(db, "accounts", accountId);
      if (!account) {
        required(customerName, "o cliente para criar a caderneta");
        account = { customer_name: customerName, note: "", created_at: createdAt.slice(0, 10), items: [] };
      }
      const accountEntries = items.map((item) => ({ id: uid(), description: item.description, quantity: item.quantity, price: item.price, created_at: createdAt, order_id: orderId }));
      account.items = [...(account.items || []), ...accountEntries];
      statements.push(putRecord(db, "accounts", accountId, account));
      if (shouldPrint) statements.push(putRecord(db, "kitchen", orderId, { items, description: `${items.length} itens`, quantity: items.reduce((sum, item) => sum + item.quantity, 0), customer_name: account.customer_name, note, origin: "Caderneta", created_at: createdAt, print_status: "pending", print_count: 0 }));
    } else {
      const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
      if (!open) throw new Error("Abra o caixa no Admin antes de registrar a venda direta.");
      required(input.payment_method, "a forma de pagamento");
      for (const item of items) {
        const saleId = uid();
        statements.push(putRecord(db, "sales", saleId, { description: item.description, quantity: item.quantity, price: item.price, payment_method: input.payment_method, note, customer_name: customerName, cash_session_id: open.id, order_id: orderId, created_at: createdAt }));
      }
      if (shouldPrint) statements.push(putRecord(db, "kitchen", orderId, { items, description: `${items.length} itens`, quantity: items.reduce((sum, item) => sum + item.quantity, 0), customer_name: customerName, note, origin: "Venda", payment_method: input.payment_method, created_at: createdAt, print_status: "pending", print_count: 0 }));
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
    const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' LIMIT 1").first();
    if (!open) await putRecord(db, "cash", id, { status: "open", opened_at: now(), closed_at: "" }).run();
  } else if (action === "cash.close") {
    const cash = await readRecord(db, "cash", id);
    if (!cash || cash.status !== "open") throw new Error("Caixa aberto não encontrado.");
    const sales = await db.prepare("SELECT data FROM records WHERE kind='sales' AND json_extract(data,'$.cash_session_id')=?").bind(id).all();
    const parsed = sales.results.map((row) => JSON.parse(row.data));
    cash.status = "closed"; cash.closed_at = now(); cash.sales_count = parsed.length;
    cash.quantity = parsed.reduce((sum, sale) => sum + Number(sale.quantity || 0), 0);
    cash.total = parsed.reduce((sum, sale) => sum + Number(sale.quantity || 0) * Number(sale.price || 0), 0);
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
