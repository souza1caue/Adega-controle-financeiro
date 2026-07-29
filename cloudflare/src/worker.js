const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const KINDS = ["menu", "accounts", "account_payments", "sales", "kitchen", "cash", "stock_movements", "stock_items", "recipes", "inventories", "employees", "staff_shifts"];

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
  const balances = await db.prepare("SELECT id,quantity,updated_at FROM stock_balances").all();
  for (const balance of balances.results) if (result.stock_items[balance.id]) {
    result.stock_items[balance.id].stock_quantity = Number(balance.quantity);
    result.stock_items[balance.id].stock_updated_at = balance.updated_at;
  }
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

function stockNumber(value, label = "a quantidade", allowZero = true) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) throw new Error(`Informe ${label} válido.`);
  return Math.round(parsed * 1000) / 1000;
}

// Converte somente unidades compatíveis; os demais insumos devem ser cadastrados
// na unidade física que será baixada (ex.: garrafa, lata ou unidade).
const UNIT_FACTORS = { ml: { ml: 1, L: .001 }, L: { ml: 1000, L: 1 }, g: { g: 1, kg: .001 }, kg: { g: 1000, kg: 1 } };
function recipeQuantity(value, fromUnit, stockUnit) {
  const qty = stockNumber(value, "o consumo por venda", false);
  if (!fromUnit || fromUnit === stockUnit) return qty;
  const factor = UNIT_FACTORS[stockUnit]?.[fromUnit];
  if (!factor) throw new Error(`Não é possível converter ${fromUnit} para ${stockUnit}.`);
  return Math.round(qty * factor * 10000) / 10000;
}

async function recipeUsage(db, menuId, multiplier = 1) {
  const recipe = await readRecord(db, "recipes", menuId);
  // Compatibilidade: itens ainda não configurados continuam vendáveis, porém
  // não movimentam estoque até receberem uma ficha técnica.
  if (!Array.isArray(recipe?.components) || !recipe.components.length) return [];
  const usage = [];
  for (const component of recipe.components) {
    const stockItem = await readRecord(db, "stock_items", component.stock_item_id);
    if (!stockItem) throw new Error("A ficha técnica possui um insumo removido. Corrija-a antes de vender.");
    usage.push({ stock_item_id: component.stock_item_id, quantity: Number(component.quantity) * multiplier, item_name: stockItem.name, unit: stockItem.unit || "un", unit_cost: Number(stockItem.cost_price || 0), recipe_updated_at: recipe.updated_at || "" });
  }
  return usage;
}

async function orderOrigin(db, token) {
  const fallback = { source_type: "station", source_name: "Caixa principal" };
  if (!token) return fallback;
  const tokenHash = await sha256(token);
  const row = await db.prepare("SELECT data FROM records WHERE kind='staff_access' AND json_extract(data,'$.token_hash')=? LIMIT 1").bind(tokenHash).first();
  if (!row) throw new Error("Este acesso de funcionário não é válido.");
  const access = JSON.parse(row.data);
  if (access.revoked_at || new Date(access.expires_at).getTime() < Date.now()) throw new Error("O acesso deste funcionário expirou. Leia um novo QR Code.");
  const shift = await readRecord(db, "staff_shifts", access.shift_id);
  if (!shift || shift.status === "cancelled") throw new Error("O acesso deste funcionário foi revogado.");
  return { source_type: "staff", source_name: access.employee_name, source_shift_id: access.shift_id };
}

function stockMovement(db, menuId, product, type, quantityValue, details = {}) {
  const movementQuantity = stockNumber(quantityValue, "a quantidade da movimentação", false);
  const before = Number(product.stock_quantity || 0);
  const signed = ["sale", "loss", "out"].includes(type) ? -movementQuantity : movementQuantity;
  const after = Math.round((before + signed) * 1000) / 1000;
  if (after < 0) throw new Error(`Estoque insuficiente para ${product.name}. Disponível: ${before}.`);
  product.stock_quantity = after;
  product.stock_updated_at = now();
  return putRecord(db, "stock_movements", uid(), {
    menu_id: details.legacy_menu ? menuId : "", stock_item_id: details.legacy_menu ? "" : menuId, product_name: product.name, type, quantity: movementQuantity,
    signed_quantity: signed, balance_before: before, balance_after: after,
    unit_cost: Number(details.unit_cost ?? product.cost_price ?? 0),
    reason: (details.reason || "").trim(), responsible: (details.responsible || "").trim(),
    reference_id: details.reference_id || "", created_at: now(),
  });
}

function atomicStockChange(db, stockItemId, product, type, quantityValue, details = {}) {
  const movementQuantity = stockNumber(quantityValue, "a quantidade da movimentação", false);
  const signed = ["sale", "loss", "out"].includes(type) ? -movementQuantity : movementQuantity;
  const movementId = uid();
  const update = db.prepare("UPDATE stock_balances SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(signed, stockItemId);
  const movement = db.prepare(`INSERT INTO records(kind,id,data,updated_at)
    SELECT 'stock_movements',?,json_object(
      'stock_item_id',?,'product_name',?,'type',?,'quantity',?,'signed_quantity',?,
      'balance_before',quantity-?,'balance_after',quantity,'unit_cost',?,
      'reason',?,'responsible',?,'reference_id',?,'created_at',?
    ),CURRENT_TIMESTAMP FROM stock_balances WHERE id=?`)
    .bind(movementId, stockItemId, product.name, type, movementQuantity, signed, signed,
      Number(details.unit_cost || product.cost_price || 0), (details.reason || "").trim(),
      (details.responsible || "").trim(), details.reference_id || "", now(), stockItemId);
  return [update, movement];
}

function accountBalance(account) {
  const charges = (account.items || []).filter((item) => !item.cancelled_at)
    .reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.price || 0), 0);
  return Math.max(0, Math.round((charges - Number(account.payments_total || 0)) * 100) / 100);
}

function assertAccountCanCharge(account, charge) {
  if (account.blocked === true) throw new Error(`A caderneta de ${account.customer_name} está bloqueada para novos consumos.`);
  const limit = Number(account.credit_limit || 0);
  const resultingBalance = Math.round((accountBalance(account) + Number(charge || 0)) * 100) / 100;
  if (limit > 0 && resultingBalance > limit + 0.001) {
    const available = Math.max(0, limit - accountBalance(account));
    throw new Error(`Limite da caderneta excedido. Disponível: R$ ${available.toFixed(2).replace(".", ",")}.`);
  }
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
    const recipe = await readRecord(db, "recipes", inputItem.menu_id);
    result.push({
      menu_id: inputItem.menu_id,
      description: menuItem.name,
      quantity: quantity(inputItem.quantity),
      price: Number(menuItem.price),
      category: isFood(menuItem) ? "Comidas" : "Bebidas",
      note: (inputItem.note || "").trim(),
      menu_item: menuItem,
      stock_usage: await recipeUsage(db, inputItem.menu_id),
    });
  }
  return result;
}

async function mutate(request, env) {
  const input = await request.json();
  const action = input.action;
  const adminActions = new Set(["menu.create", "menu.update", "menu.delete", "sale.delete", "sale.void", "cash.open", "cash.movement", "cash.close", "stock.configure", "stock.move", "stock.item.save", "stock.item.delete", "stock.item.move", "recipe.save", "inventory.start", "inventory.finish", "employee.save", "employee.toggle", "staff.shift.save", "staff.shift.pay", "staff.shift.cancel", "staff.access.create", "staff.access.revoke"]);
  if (adminActions.has(action) && !(await isAdmin(request, env))) return reply({ error: "Acesso administrativo necessário." }, 401);
  const db = env.DB;
  const id = input.id || uid();

  if (action === "menu.create" || action === "menu.update") {
    required(input.name, "o nome do item");
    const item = { ...(action === "menu.update" ? await readRecord(db, "menu", id) : {}), name: input.name.trim(), price: Number(input.price), category: input.category === "Comidas" ? "Comidas" : "Bebidas" };
    item[action === "menu.create" ? "created_at" : "updated_at"] = now();
    await putRecord(db, "menu", id, item).run();
  } else if (action === "employee.save") {
    required(input.name, "o nome do funcionário");
    if (!["Adega", "Cozinha"].includes(input.group)) throw new Error("Grupo de funcionário inválido.");
    const employee = { ...(await readRecord(db, "employees", id) || {}), name: input.name.trim(), group: input.group, daily_rate: amount(input.daily_rate, "a diária", false), active: input.active !== false && input.active !== "false", note: (input.note || "").trim(), updated_at: now() };
    if (!employee.created_at) employee.created_at = now();
    await putRecord(db, "employees", id, employee).run();
  } else if (action === "employee.toggle") {
    const employee = await readRecord(db, "employees", id);
    if (!employee) throw new Error("Funcionário não encontrado.");
    employee.active = !employee.active; employee.updated_at = now();
    await putRecord(db, "employees", id, employee).run();
  } else if (action === "staff.shift.save") {
    const employee = await readRecord(db, "employees", input.employee_id);
    if (!employee) throw new Error("Funcionário não encontrado.");
    required(input.work_date, "a data de trabalho");
    const duplicate = await db.prepare("SELECT id FROM records WHERE kind='staff_shifts' AND json_extract(data,'$.employee_id')=? AND json_extract(data,'$.work_date')=? AND json_extract(data,'$.status')!='cancelled' LIMIT 1").bind(input.employee_id, input.work_date).first();
    if (duplicate && duplicate.id !== id) throw new Error("Este funcionário já está registrado nesta data.");
    const shift = { ...(await readRecord(db, "staff_shifts", id) || {}), employee_id: input.employee_id, employee_name: employee.name, group: employee.group, work_date: input.work_date, daily_rate: amount(input.daily_rate, "a diária", false), status: "confirmed", note: (input.note || "").trim(), updated_at: now() };
    if (!shift.created_at) shift.created_at = now();
    await putRecord(db, "staff_shifts", id, shift).run();
  } else if (action === "staff.shift.pay") {
    const shift = await readRecord(db, "staff_shifts", id);
    if (!shift || shift.status === "cancelled") throw new Error("Diária não encontrada.");
    if (shift.status === "paid") throw new Error("Esta diária já foi paga.");
    required(input.responsible, "o responsável");
    if (!["Dinheiro", "Pix", "Outro"].includes(input.payment_method)) throw new Error("Forma de pagamento inválida.");
    shift.status = "paid"; shift.payment_method = input.payment_method; shift.paid_at = now(); shift.paid_by = input.responsible.trim(); shift.payment_note = (input.note || "").trim();
    const statements = [putRecord(db, "staff_shifts", id, shift)];
    if (input.payment_method === "Dinheiro") {
      const open = await db.prepare("SELECT id,data FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
      if (!open) throw new Error("Abra o caixa antes de pagar uma diária em dinheiro.");
      const cash = JSON.parse(open.data);
      cash.movements = [...(cash.movements || []), { id: uid(), type: "withdrawal", amount: Number(shift.daily_rate), responsible: shift.paid_by, note: `Diária — ${shift.employee_name}${shift.payment_note ? ` · ${shift.payment_note}` : ""}`, created_at: now(), staff_shift_id: id }];
      statements.push(putRecord(db, "cash", open.id, cash));
    }
    await db.batch(statements);
  } else if (action === "staff.shift.cancel") {
    const shift = await readRecord(db, "staff_shifts", id);
    if (!shift) throw new Error("Diária não encontrada.");
    if (shift.status === "paid") throw new Error("Não é possível cancelar uma diária já paga.");
    shift.status = "cancelled"; shift.cancelled_at = now();
    await putRecord(db, "staff_shifts", id, shift).run();
  } else if (action === "staff.access.create") {
    const shift = await readRecord(db, "staff_shifts", id);
    if (!shift || shift.status === "cancelled" || shift.group !== "Adega") throw new Error("O acesso é exclusivo para funcionários da Adega escalados no dia.");
    const rawToken = `${uid()}${uid()}`;
    const accessId = uid();
    const access = { shift_id: id, employee_name: shift.employee_name, token_hash: await sha256(rawToken), created_at: now(), expires_at: `${shift.work_date}T23:59:59-03:00` };
    const previous = await db.prepare("SELECT id,data FROM records WHERE kind='staff_access' AND json_extract(data,'$.shift_id')=? AND json_extract(data,'$.revoked_at') IS NULL").bind(id).all();
    const statements = previous.results.map(row => { const oldAccess = JSON.parse(row.data); oldAccess.revoked_at = now(); return putRecord(db, "staff_access", row.id, oldAccess); });
    statements.push(putRecord(db, "staff_access", accessId, access));
    await db.batch(statements);
    return reply({ ok: true, id: accessId, access_token: rawToken, expires_at: access.expires_at });
  } else if (action === "staff.access.revoke") {
    const rows = await db.prepare("SELECT id,data FROM records WHERE kind='staff_access' AND json_extract(data,'$.shift_id')=? AND json_extract(data,'$.revoked_at') IS NULL").bind(id).all();
    const statements = rows.results.map(row => { const access = JSON.parse(row.data); access.revoked_at = now(); return putRecord(db, "staff_access", row.id, access); });
    if (statements.length) await db.batch(statements);
  } else if (action === "stock.item.save") {
    required(input.name, "o nome do insumo");
    const item = { ...(await readRecord(db, "stock_items", id) || {}), name: input.name.trim(), unit: (input.unit || "un").trim(), stock_minimum: stockNumber(input.stock_minimum || 0, "o estoque mínimo"), cost_price: amount(input.cost_price || 0, "o custo"), sku: (input.sku || "").trim(), barcode: (input.barcode || "").trim(), supplier: (input.supplier || "").trim(), updated_at: now() };
    if (item.stock_quantity == null) item.stock_quantity = 0;
    if (!item.created_at) item.created_at = now();
    await db.batch([
      putRecord(db, "stock_items", id, item),
      db.prepare("INSERT OR IGNORE INTO stock_balances(id,quantity) VALUES(?,?)").bind(id, Number(item.stock_quantity || 0)),
    ]);
  } else if (action === "stock.item.delete") {
    const linked = await db.prepare("SELECT id FROM records WHERE kind='recipes' AND EXISTS (SELECT 1 FROM json_each(json_extract(data,'$.components')) WHERE json_extract(value,'$.stock_item_id')=?) LIMIT 1").bind(id).first();
    if (linked) throw new Error("Este insumo está vinculado a uma ficha técnica. Remova o vínculo antes de excluí-lo.");
    await db.prepare("DELETE FROM records WHERE kind='stock_items' AND id=?").bind(id).run();
  } else if (action === "stock.item.move") {
    const item = await readRecord(db, "stock_items", id);
    if (!item) throw new Error("Insumo não encontrado.");
    if (!["in", "out", "loss", "adjustment"].includes(input.type)) throw new Error("Tipo de movimentação inválido.");
    required(input.responsible, "o responsável");
    required(input.reason, "o motivo");
    const balance = await db.prepare("SELECT quantity FROM stock_balances WHERE id=?").bind(id).first();
    const current = Number(balance?.quantity || 0);
    const desired = input.type === "adjustment" ? stockNumber(input.new_balance, "o novo saldo") : null;
    const movementType = input.type === "adjustment" ? (desired >= current ? "adjustment_in" : "out") : input.type;
    const movementQty = input.type === "adjustment" ? Math.abs(desired - current) : input.quantity;
    if (Number(movementQty) === 0) throw new Error("O novo saldo é igual ao saldo atual.");
    if (input.type === "in" && input.unit_cost !== "" && input.unit_cost != null) {
      const entryCost = amount(input.unit_cost, "o custo");
      item.cost_price = Math.round(((current * Number(item.cost_price || 0) + Number(movementQty) * entryCost) / (current + Number(movementQty))) * 100) / 100;
      item.last_cost_price = entryCost;
    }
    const atomic = atomicStockChange(db, id, item, movementType, movementQty, input);
    await db.batch([putRecord(db, "stock_items", id, item), ...atomic]);
  } else if (action === "recipe.save") {
    const menuItem = await readRecord(db, "menu", id);
    if (!menuItem) throw new Error("Produto do cardápio não encontrado.");
    const components = Array.isArray(input.components) ? input.components : [];
    const componentTotals = new Map();
    for (const component of components) {
      const stockItem = await readRecord(db, "stock_items", component.stock_item_id);
      if (!stockItem) throw new Error("Um dos insumos selecionados não existe.");
      componentTotals.set(component.stock_item_id, (componentTotals.get(component.stock_item_id) || 0) + recipeQuantity(component.quantity, component.unit, stockItem.unit || "un"));
    }
    const normalized = [...componentTotals].map(([stock_item_id, quantity]) => ({ stock_item_id, quantity: Math.round(quantity * 10000) / 10000 }));
    if (normalized.length) await putRecord(db, "recipes", id, { menu_id: id, product_name: menuItem.name, components: normalized, updated_at: now() }).run();
    else await db.prepare("DELETE FROM records WHERE kind='recipes' AND id=?").bind(id).run();
  } else if (action === "inventory.start") {
    required(input.responsible, "o responsável");
    const balances = await db.prepare("SELECT id,quantity FROM stock_balances ORDER BY id").all();
    const items = balances.results.map((row) => ({ stock_item_id: row.id, expected: Number(row.quantity), counted: null }));
    await putRecord(db, "inventories", id, { status: "open", responsible: input.responsible.trim(), note: (input.note || "").trim(), items, created_at: now() }).run();
  } else if (action === "inventory.finish") {
    const inventory = await readRecord(db, "inventories", id);
    if (!inventory || inventory.status !== "open") throw new Error("Inventário aberto não encontrado.");
    required(input.responsible, "o responsável pela conferência");
    const counts = Array.isArray(input.counts) ? input.counts : [];
    const statements = [];
    for (const count of counts) {
      const item = await readRecord(db, "stock_items", count.stock_item_id);
      if (!item) continue;
      const balance = await db.prepare("SELECT quantity FROM stock_balances WHERE id=?").bind(count.stock_item_id).first();
      const current = Number(balance?.quantity || 0);
      const counted = stockNumber(count.counted, `a contagem de ${item.name}`);
      const difference = Math.round((counted - current) * 1000) / 1000;
      const inventoryItem = inventory.items.find((entry) => entry.stock_item_id === count.stock_item_id);
      if (inventoryItem) { inventoryItem.counted = counted; inventoryItem.difference = difference; }
      if (difference !== 0) statements.push(...atomicStockChange(db, count.stock_item_id, item, difference > 0 ? "adjustment_in" : "out", Math.abs(difference), { reason: `Inventário ${id.slice(0, 8)}`, responsible: input.responsible, reference_id: id }));
    }
    inventory.status = "closed"; inventory.closed_at = now(); inventory.closed_by = input.responsible.trim();
    statements.unshift(putRecord(db, "inventories", id, inventory));
    await db.batch(statements);
  } else if (action === "stock.configure") {
    const item = await readRecord(db, "menu", id);
    if (!item) throw new Error("Produto não encontrado.");
    item.stock_controlled = input.stock_controlled === true || input.stock_controlled === "true";
    item.stock_minimum = stockNumber(input.stock_minimum || 0, "o estoque mínimo");
    item.cost_price = amount(input.cost_price || 0, "o custo");
    item.sku = (input.sku || "").trim();
    item.barcode = (input.barcode || "").trim();
    item.supplier = (input.supplier || "").trim();
    item.unit = (input.unit || "un").trim();
    item.stock_updated_at = now();
    await putRecord(db, "menu", id, item).run();
  } else if (action === "stock.move") {
    const item = await readRecord(db, "menu", id);
    if (!item) throw new Error("Produto não encontrado.");
    if (!item.stock_controlled) throw new Error("Ative o controle de estoque deste produto primeiro.");
    if (!["in", "out", "loss", "adjustment"].includes(input.type)) throw new Error("Tipo de movimentação inválido.");
    required(input.responsible, "o responsável");
    required(input.reason, "o motivo");
    const current = Number(item.stock_quantity || 0);
    const desired = input.type === "adjustment" ? stockNumber(input.new_balance, "o novo saldo") : null;
    const movementType = input.type === "adjustment" ? (desired >= current ? "adjustment_in" : "out") : input.type;
    const movementQty = input.type === "adjustment" ? Math.abs(desired - current) : input.quantity;
    if (Number(movementQty) === 0) throw new Error("O novo saldo é igual ao saldo atual.");
    if (input.type === "in" && input.unit_cost !== "" && input.unit_cost != null) item.cost_price = amount(input.unit_cost, "o custo");
    const movement = stockMovement(db, id, item, movementType, movementQty, { ...input, legacy_menu: true });
    await db.batch([putRecord(db, "menu", id, item), movement]);
  } else if (action === "menu.delete") {
    await db.prepare("DELETE FROM records WHERE kind='menu' AND id=?").bind(id).run();
  } else if (action === "account.create") {
    required(input.customer_name, "o nome do cliente");
    await putRecord(db, "accounts", id, { customer_name: input.customer_name.trim(), note: (input.note || "").trim(), credit_limit: amount(input.credit_limit || 0, "o limite da caderneta"), blocked: input.blocked === true, created_at: now().slice(0, 10), items: [], payments_total: 0 }).run();
  } else if (action === "account.update") {
    const account = await readRecord(db, "accounts", id);
    if (!account) throw new Error("Caderneta não encontrada.");
    required(input.customer_name, "o nome do cliente");
    account.customer_name = input.customer_name.trim();
    account.note = (input.note || "").trim();
    account.credit_limit = amount(input.credit_limit || 0, "o limite da caderneta");
    account.blocked = input.blocked === true;
    delete account.phone;
    delete account.due_days;
    account.updated_at = now();
    await putRecord(db, "accounts", id, account).run();
  } else if (action === "account.addItem") {
    const account = await readRecord(db, "accounts", id);
    if (!account) throw new Error("Conta não encontrada.");
    required(input.description, "o item");
    const createdAt = now();
    const orderId = uid();
    const origin = await orderOrigin(db, input.origin_token);
    const entry = { id: uid(), menu_id: input.menu_id || "", description: input.description.trim(), quantity: quantity(input.quantity), price: amount(input.price, "o preço"), note: (input.note || "").trim(), created_at: createdAt, order_id: orderId, created_by: origin.source_name, created_source_type: origin.source_type, created_shift_id: origin.source_shift_id || "", stock_usage: [] };
    assertAccountCanCharge(account, Number(entry.quantity) * Number(entry.price));
    if (entry.menu_id) entry.stock_usage = await recipeUsage(db, entry.menu_id, entry.quantity);
    account.items = [...(account.items || []), entry];
    const statements = [
      putRecord(db, "accounts", id, account),
      putRecord(db, "sales", uid(), { menu_id: entry.menu_id, stock_usage: entry.stock_usage, description: entry.description, quantity: entry.quantity, price: entry.price, customer_name: account.customer_name, payment_method: "Caderneta", account_id: id, account_item_id: entry.id, order_id: orderId, created_at: createdAt, ...origin }),
    ];
    if (entry.stock_usage.length) {
      for (const usage of entry.stock_usage) {
        const stockItem = await readRecord(db, "stock_items", usage.stock_item_id);
        if (!stockItem) throw new Error("Um insumo da ficha técnica não existe mais.");
        statements.push(...atomicStockChange(db, usage.stock_item_id, stockItem, "sale", usage.quantity, { reason: `Venda de ${entry.description}`, responsible: "Sistema", reference_id: orderId }));
      }
    } else if (entry.menu_id) {
      const product = await readRecord(db, "menu", entry.menu_id);
      if (product?.stock_controlled) {
        const movement = stockMovement(db, entry.menu_id, product, "sale", entry.quantity, { reason: "Consumo em caderneta", responsible: "Sistema", reference_id: orderId, legacy_menu: true });
        statements.push(putRecord(db, "menu", entry.menu_id, product), movement);
      }
    }
    if (input.print_order || input.send_to_kitchen) statements.push(putRecord(db, "kitchen", uid(), { ...entry, customer_name: account.customer_name, note: (input.note || "").trim(), origin: "Caderneta", status: "pending", print_status: "pending", print_count: 0 }));
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
    if (Array.isArray(item.stock_usage) && item.stock_usage.length) {
      for (const usage of item.stock_usage) {
        const stockItem = await readRecord(db, "stock_items", usage.stock_item_id);
        if (!stockItem) continue;
        statements.push(...atomicStockChange(db, usage.stock_item_id, stockItem, "return", usage.quantity, { reason: `Cancelamento: ${item.cancel_reason}`, responsible: item.cancelled_by, reference_id: item.order_id }));
      }
    } else if (item.menu_id) {
      const product = await readRecord(db, "menu", item.menu_id);
      if (product?.stock_controlled) {
        const movement = stockMovement(db, item.menu_id, product, "return", item.quantity, { reason: `Cancelamento: ${item.cancel_reason}`, responsible: item.cancelled_by, reference_id: item.order_id, legacy_menu: true });
        statements.push(putRecord(db, "menu", item.menu_id, product), movement);
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
    const remainingBalance = Math.max(0, Math.round((balance - received) * 100) / 100);
    account.payments_total = Math.round((Number(account.payments_total || 0) + received) * 100) / 100;
    account.last_payment_at = createdAt;
    const accountStatement = remainingBalance <= 0.001
      ? db.prepare("DELETE FROM records WHERE kind='accounts' AND id=?").bind(id)
      : putRecord(db, "accounts", id, account);
    await db.batch([accountStatement, putRecord(db, "account_payments", paymentId, payment)]);
    return reply({ ok: true, id: paymentId, balance_after: remainingBalance, closed: remainingBalance <= 0.001 });
  } else if (action === "sale.checkout") {
    const items = await cartItems(db, input.items);
    const createdAt = now();
    const origin = await orderOrigin(db, input.origin_token);
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
        account = { customer_name: customerName, note: "", credit_limit: 0, blocked: false, created_at: createdAt.slice(0, 10), items: [], payments_total: 0 };
      }
      assertAccountCanCharge(account, items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.price), 0));
      const accountEntries = items.map((item) => ({ id: uid(), menu_id: item.menu_id, stock_usage: item.stock_usage.map((usage) => ({ ...usage, quantity: Number(usage.quantity) * item.quantity })), description: item.description, quantity: item.quantity, price: item.price, note: item.note, created_at: createdAt, order_id: orderId, created_by: origin.source_name, created_source_type: origin.source_type, created_shift_id: origin.source_shift_id || "" }));
      account.items = [...(account.items || []), ...accountEntries];
      statements.push(putRecord(db, "accounts", accountId, account));
      for (const entry of accountEntries) statements.push(putRecord(db, "sales", uid(), { menu_id: entry.menu_id, stock_usage: entry.stock_usage, description: entry.description, quantity: entry.quantity, price: entry.price, item_note: entry.note, note, customer_name: account.customer_name, payment_method: "Caderneta", account_id: accountId, account_item_id: entry.id, order_id: orderId, created_at: createdAt, ...origin }));
      if (shouldPrint) statements.push(putRecord(db, "kitchen", orderId, { items: foodItems, description: `${foodItems.length} itens`, quantity: foodItems.reduce((sum, item) => sum + item.quantity, 0), customer_name: account.customer_name, note, origin: "Caderneta", created_at: createdAt, status: "pending", print_status: "pending", print_count: 0, created_by: origin.source_name, created_source_type: origin.source_type, created_shift_id: origin.source_shift_id || "" }));
    } else {
      const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
      if (!open) throw new Error("Abra o caixa no Admin antes de usar a opção Pagar agora.");
      required(input.payment_method, "a forma de pagamento");
      if (shouldPrint) required(customerName, "o nome do cliente para enviar o pedido à cozinha");
      for (const item of items) {
        const saleId = uid();
        statements.push(putRecord(db, "sales", saleId, { menu_id: item.menu_id, stock_usage: item.stock_usage.map((usage) => ({ ...usage, quantity: Number(usage.quantity) * item.quantity })), description: item.description, quantity: item.quantity, price: item.price, item_note: item.note, note, customer_name: customerName, payment_method: input.payment_method, cash_session_id: open.id, order_id: orderId, created_at: createdAt, ...origin }));
      }
      if (shouldPrint) statements.push(putRecord(db, "kitchen", orderId, { items: foodItems, description: `${foodItems.length} itens`, quantity: foodItems.reduce((sum, item) => sum + item.quantity, 0), customer_name: customerName, note, origin: "Venda", payment_method: input.payment_method, created_at: createdAt, status: "pending", print_status: "pending", print_count: 0, created_by: origin.source_name, created_source_type: origin.source_type, created_shift_id: origin.source_shift_id || "" }));
    }
    const requirements = new Map();
    for (const item of items) for (const usage of item.stock_usage) requirements.set(usage.stock_item_id, (requirements.get(usage.stock_item_id) || 0) + Number(usage.quantity) * item.quantity);
    for (const [stockItemId, requiredQuantity] of requirements) {
      const stockItem = await readRecord(db, "stock_items", stockItemId);
      if (!stockItem) throw new Error("Um insumo da ficha técnica não existe mais.");
      const balance = await db.prepare("SELECT quantity FROM stock_balances WHERE id=?").bind(stockItemId).first();
      if (Number(balance?.quantity || 0) + 0.000001 < requiredQuantity) throw new Error(`Estoque insuficiente de ${stockItem.name}. Disponível: ${Number(balance?.quantity || 0)} ${stockItem.unit || "un"}.`);
      statements.push(...atomicStockChange(db, stockItemId, stockItem, "sale", requiredQuantity, { reason: `Pedido com ${items.map((item) => item.description).join(", ")}`, responsible: "Sistema", reference_id: orderId }));
    }
    for (const item of items) {
      if (item.stock_usage.length || !item.stock_controlled) continue;
      const movement = stockMovement(db, item.menu_id, item.menu_item, "sale", item.quantity, { reason: "Venda", responsible: "Sistema", reference_id: orderId, legacy_menu: true });
      statements.push(putRecord(db, "menu", item.menu_id, item.menu_item), movement);
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
      statements.push(putRecord(db, "kitchen", uid(), { ...sale, origin: "Venda", status: "pending", print_status: "pending", print_count: 0 }));
    }
    await db.batch(statements);
  } else if (action === "sale.delete") {
    const sale = await readRecord(db, "sales", id);
    if (sale?.account_id) throw new Error("Consumos de caderneta não podem ser apagados. Use o cancelamento com responsável e justificativa.");
    await db.prepare("DELETE FROM records WHERE kind='sales' AND id=?").bind(id).run();
  } else if (action === "sale.void") {
    required(input.reason, "a justificativa do cancelamento");
    const sale = await readRecord(db, "sales", id);
    if (!sale) throw new Error("Lançamento não encontrado.");
    if (sale.voided_at) throw new Error("Este lançamento já foi cancelado.");
    if (sale.account_id) throw new Error("Cancele este consumo diretamente na caderneta para manter o saldo e o estoque consistentes.");
    sale.voided_at = now();
    sale.void_reason = input.reason.trim();
    sale.voided_by = (input.responsible || "Admin").trim();
    const statements = [];
    if (Array.isArray(sale.stock_usage) && sale.stock_usage.length && !sale.stock_restored_at) {
      for (const usage of sale.stock_usage) {
        const stockItem = await readRecord(db, "stock_items", usage.stock_item_id);
        if (!stockItem) continue;
        statements.push(...atomicStockChange(db, usage.stock_item_id, stockItem, "return", usage.quantity, { reason: `Cancelamento de venda: ${sale.void_reason}`, responsible: sale.voided_by, reference_id: sale.order_id || id }));
      }
      sale.stock_restored_at = now();
    } else if (sale.menu_id && !sale.stock_restored_at) {
      const product = await readRecord(db, "menu", sale.menu_id);
      if (product?.stock_controlled) {
        const movement = stockMovement(db, sale.menu_id, product, "return", sale.quantity, { reason: `Cancelamento de venda: ${sale.void_reason}`, responsible: sale.voided_by, reference_id: sale.order_id || id, legacy_menu: true });
        statements.push(putRecord(db, "menu", sale.menu_id, product), movement);
        sale.stock_restored_at = now();
      }
    }
    statements.unshift(putRecord(db, "sales", id, sale));
    await db.batch(statements);
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
  } else if (action === "kitchen.status") {
    const order = await readRecord(db, "kitchen", id);
    if (!order) throw new Error("Pedido não encontrado.");
    const allowed = { started: "started_at", ready: "ready_at", delivered: "delivered_at" };
    if (!allowed[input.status]) throw new Error("Estado inválido.");
    order.status = input.status;
    order[allowed[input.status]] = now();
    if (input.status === "delivered") {
      const origin = await orderOrigin(db, input.origin_token);
      order.delivered_by = origin.source_name;
      order.delivered_source_type = origin.source_type;
      order.delivered_shift_id = origin.source_shift_id || "";
    }
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
      if (/CHECK constraint failed.*quantity|constraint failed.*stock_balances/i.test(error.message || "")) {
        return reply({ error: "O estoque mudou enquanto o pedido era finalizado. Atualize a tela e confira os itens disponíveis." }, 409);
      }
      return reply({ error: error.message || "Erro interno." }, 400);
    }
  },
};
