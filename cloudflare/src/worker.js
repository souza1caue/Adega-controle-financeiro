const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const KINDS = ["menu", "accounts", "account_payments", "sales", "kitchen", "cash", "stock_movements", "stock_items", "recipes", "inventories", "employees", "staff_shifts", "device_access", "stock_events", "hosted_events"];

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const operationalDate = value => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));

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

async function authorizedDevice(request, env) {
  const token = request.headers.get("x-device-access") || "";
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare("SELECT id,data FROM records WHERE kind='device_access' AND json_extract(data,'$.token_hash')=? LIMIT 1").bind(tokenHash).first();
  if (!row) return null;
  const device = JSON.parse(row.data);
  if (device.revoked_at) return null;
  return { id: row.id, ...device };
}

async function login(request, env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return reply({ error: "Segredos administrativos não configurados." }, 503);
  const { password = "", remember = false } = await request.json();
  const ipId = await sha256(request.headers.get("cf-connecting-ip") || "unknown");
  const attempt = await readRecord(env.DB, "login_attempts", ipId) || { count: 0, window_started_at: now() };
  const windowAge = Date.now() - new Date(attempt.window_started_at).getTime();
  if (windowAge > 15 * 60 * 1000) { attempt.count = 0; attempt.window_started_at = now(); delete attempt.blocked_until; }
  if (attempt.blocked_until && new Date(attempt.blocked_until).getTime() > Date.now()) return reply({ error: "Muitas tentativas. Aguarde 15 minutos antes de tentar novamente." }, 429);
  if ((await sha256(password)) !== (await sha256(env.ADMIN_PASSWORD))) {
    attempt.count += 1;
    if (attempt.count >= 5) attempt.blocked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await putRecord(env.DB, "login_attempts", ipId, attempt).run();
    return reply({ error: "Senha inválida." }, 401);
  }
  await env.DB.prepare("DELETE FROM records WHERE kind='login_attempts' AND id=?").bind(ipId).run();
  const token = `${uid()}${uid()}`;
  const tokenHash = await sha256(`${token}:${env.SESSION_SECRET}`);
  const expires = new Date(Date.now() + (remember ? 30 * 24 : 12) * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<=CURRENT_TIMESTAMP"),
    env.DB.prepare("INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)").bind(tokenHash, expires),
  ]);
  return reply({ token, expires });
}

async function claimDevice(request, env) {
  const { code = "" } = await request.json();
  if (!/^\d{6}$/.test(String(code))) return reply({ error: "Informe o código de 6 dígitos." }, 400);
  const codeHash = await sha256(String(code));
  const row = await env.DB.prepare("SELECT id,data FROM records WHERE kind='device_access' AND json_extract(data,'$.claim_code_hash')=? AND json_extract(data,'$.claimed_at') IS NULL LIMIT 1").bind(codeHash).first();
  if (!row) return reply({ error: "Código inválido ou já utilizado." }, 401);
  const device = JSON.parse(row.data);
  if (device.revoked_at || new Date(device.claim_expires_at).getTime() < Date.now()) return reply({ error: "Este código expirou. Gere outro no Admin." }, 401);
  const token = `${uid()}${uid()}`;
  device.token_hash = await sha256(token);
  device.claimed_at = now();
  delete device.claim_code_hash;
  const result = await env.DB.prepare("UPDATE records SET data=?,updated_at=CURRENT_TIMESTAMP WHERE kind='device_access' AND id=? AND json_extract(data,'$.claimed_at') IS NULL").bind(JSON.stringify(device), row.id).run();
  if (Number(result.meta?.changes || 0) !== 1) return reply({ error: "Este código já foi usado em outro aparelho." }, 409);
  return reply({ access_token: token, role: device.role, label: device.label });
}

async function claimStaffAccess(request, env) {
  const { invite_token = "" } = await request.json();
  if (!invite_token) return reply({ error: "QR Code inválido." }, 400);
  const tokenHash = await sha256(invite_token);
  const row = await env.DB.prepare("SELECT id,data FROM records WHERE kind='staff_access' AND json_extract(data,'$.token_hash')=? LIMIT 1").bind(tokenHash).first();
  if (!row) return reply({ error: "Este QR Code já foi utilizado ou não é válido." }, 401);
  const access = JSON.parse(row.data);
  if (access.claimed_at || access.revoked_at || new Date(access.expires_at).getTime() < Date.now()) return reply({ error: "Este QR Code já foi utilizado ou expirou." }, 401);
  const cash = await readRecord(env.DB, "cash", access.cash_session_id);
  if (!cash || cash.status !== "open") return reply({ error: "O caixa deste QR Code já foi fechado." }, 401);
  const deviceToken = `${uid()}${uid()}`;
  access.token_hash = await sha256(deviceToken);
  access.claimed_at = now();
  const result = await env.DB.prepare("UPDATE records SET data=?,updated_at=CURRENT_TIMESTAMP WHERE kind='staff_access' AND id=? AND json_extract(data,'$.claimed_at') IS NULL")
    .bind(JSON.stringify(access), row.id).run();
  if (Number(result.meta?.changes || 0) !== 1) return reply({ error: "Este QR Code já foi utilizado em outro aparelho." }, 409);
  return reply({ access_token: deviceToken, employee_name: access.employee_name });
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
function recipeQuantity(value, fromUnit, stockUnit, stockItem = {}) {
  const qty = stockNumber(value, "o consumo por venda", false);
  if (!fromUnit || fromUnit === stockUnit) return qty;
  const factor = UNIT_FACTORS[fromUnit]?.[stockUnit];
  if (factor) return Math.round(qty * factor * 10000) / 10000;
  const packageSize = Number(stockItem.package_size || 0), packageMeasure = stockItem.package_measure;
  const packageFactor = UNIT_FACTORS[fromUnit]?.[packageMeasure];
  if (packageSize > 0 && packageFactor) return Math.round(qty * packageFactor / packageSize * 10000) / 10000;
  throw new Error(`Não é possível converter ${fromUnit} para ${stockUnit}. Confira a unidade e o conteúdo da embalagem no estoque.`);
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
  if (!access.cash_session_id) throw new Error("Este acesso pertence a um caixa anterior. Leia um novo QR Code.");
  const cash = await readRecord(db, "cash", access.cash_session_id);
  if (!cash || cash.status !== "open") throw new Error("O caixa deste acesso foi fechado. Leia um novo QR Code no próximo caixa.");
  return { source_type: "staff", source_name: access.employee_name, source_shift_id: access.shift_id, cash_session_id: access.cash_session_id };
}

async function voidSaleStatements(db, id, sale, responsible, reason) {
  sale.voided_at = now(); sale.void_reason = reason; sale.voided_by = responsible;
  const statements = [];
  if (Array.isArray(sale.stock_usage) && sale.stock_usage.length && !sale.stock_restored_at) {
    for (const usage of sale.stock_usage) {
      const stockItem = await readRecord(db, "stock_items", usage.stock_item_id);
      if (stockItem) statements.push(...atomicStockChange(db, usage.stock_item_id, stockItem, "return", usage.quantity, { reason: `Cancelamento de pedido: ${reason}`, responsible, reference_id: sale.order_id || id }));
    }
    sale.stock_restored_at = now();
  } else if (sale.menu_id && !sale.stock_restored_at) {
    const product = await readRecord(db, "menu", sale.menu_id);
    if (product?.stock_controlled) {
      statements.push(putRecord(db, "menu", sale.menu_id, product), stockMovement(db, sale.menu_id, product, "return", sale.quantity, { reason: `Cancelamento de pedido: ${reason}`, responsible, reference_id: sale.order_id || id, legacy_menu: true }));
      sale.stock_restored_at = now();
    }
  }
  statements.unshift(putRecord(db, "sales", id, sale));
  return statements;
}

function stockMovement(db, menuId, product, type, quantityValue, details = {}) {
  const movementQuantity = stockNumber(quantityValue, "a quantidade da movimentação", false);
  const before = Number(product.stock_quantity || 0);
  const signed = ["sale", "loss", "out", "courtesy"].includes(type) ? -movementQuantity : movementQuantity;
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
  const signed = ["sale", "loss", "out", "courtesy"].includes(type) ? -movementQuantity : movementQuantity;
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
  const charges = Number(account.opening_balance || 0) + (account.items || []).filter((item) => !item.cancelled_at)
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
  const adminActions = new Set(["menu.save", "menu.create", "menu.update", "menu.delete", "sale.delete", "sale.void", "cash.open", "cash.movement", "cash.close", "stock.configure", "stock.move", "stock.item.save", "stock.item.delete", "stock.item.move", "stock.purchase.batch", "stock.invoice.import", "stock.event.cancel", "hosted.event.save", "hosted.event.close", "recipe.save", "inventory.start", "inventory.finish", "employee.save", "employee.toggle", "event.save", "staff.shift.save", "staff.shift.pay", "staff.shift.cancel", "staff.access.create", "staff.access.revoke", "device.create", "device.revoke"]);
  const admin = await isAdmin(request, env);
  const db = env.DB;
  const staffToken = request.headers.get("x-staff-access") || "";
  const device = await authorizedDevice(request, env);
  const frontActions = new Set(["sale.checkout", "sale.order.void", "stock.event.create", "account.addItem", "account.create", "account.update", "account.receivePayment", "account.convertToCredit", "account.cancelItem", "kitchen.status"]);
  if (staffToken) {
    if (!frontActions.has(action)) return reply({ error: "Este QR Code permite acesso somente à Frente de Caixa." }, 403);
    await orderOrigin(db, staffToken);
    input.origin_token = staffToken;
  } else if (device) {
    const allowed = device.role === "front" ? frontActions : new Set(["kitchen.status", "kitchen.printed", "kitchen.requeue"]);
    if (!allowed.has(action)) return reply({ error: `Este dispositivo possui acesso somente ${device.role === "front" ? "à Frente de Caixa" : "à Cozinha"}.` }, 403);
  } else if (!admin) return reply({ error: "Faça login para acessar o sistema." }, 401);
  if (adminActions.has(action) && !admin) return reply({ error: "Acesso administrativo necessário." }, 401);
  const id = input.id || uid();

  if (action === "device.create") {
    if (!["front", "kitchen"].includes(input.role)) throw new Error("Escolha Caixa ou Cozinha.");
    required(input.label, "o nome do dispositivo");
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
    const access = { label: input.label.trim(), role: input.role, claim_code_hash: await sha256(code), claim_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), created_at: now() };
    await putRecord(db, "device_access", id, access).run();
    return reply({ ok: true, id, code, expires_at: access.claim_expires_at });
  } else if (action === "device.revoke") {
    const access = await readRecord(db, "device_access", id);
    if (!access) throw new Error("Dispositivo não encontrado.");
    access.revoked_at = now();
    await putRecord(db, "device_access", id, access).run();
  } else if (action === "menu.save") {
    required(input.name, "o nome do item");
    const price = Number(input.price);
    if (!Number.isFinite(price) || price < 0) throw new Error("Informe um preço válido.");
    const existing = input.id ? await readRecord(db, "menu", id) : null;
    if (input.id && !existing) throw new Error("Produto do cardápio não encontrado.");
    const item = { ...(existing || {}), name: input.name.trim(), price, category: input.category === "Comidas" ? "Comidas" : "Bebidas" };
    item[existing ? "updated_at" : "created_at"] = now();
    const components = Array.isArray(input.components) ? input.components : [];
    const componentTotals = new Map();
    for (const component of components) {
      const stockItem = await readRecord(db, "stock_items", component.stock_item_id);
      if (!stockItem) throw new Error("Um dos insumos selecionados não existe.");
      const stockUnit = stockItem.unit || "un", inputUnit = component.unit || stockUnit;
      const normalizedQuantity = recipeQuantity(component.quantity, inputUnit, stockUnit, stockItem);
      const current = componentTotals.get(component.stock_item_id);
      componentTotals.set(component.stock_item_id, current ? { quantity: current.quantity + normalizedQuantity, input_quantity: current.quantity + normalizedQuantity, input_unit: stockUnit } : { quantity: normalizedQuantity, input_quantity: Number(component.quantity), input_unit: inputUnit });
    }
    const normalized = [...componentTotals].map(([stock_item_id, component]) => ({ stock_item_id, quantity: Math.round(component.quantity * 10000) / 10000, input_quantity: component.input_quantity, input_unit: component.input_unit }));
    const statements = [putRecord(db, "menu", id, item)];
    if (normalized.length) statements.push(putRecord(db, "recipes", id, { menu_id: id, product_name: item.name, components: normalized, updated_at: now() }));
    else statements.push(db.prepare("DELETE FROM records WHERE kind='recipes' AND id=?").bind(id));
    await db.batch(statements);
  } else if (action === "menu.create" || action === "menu.update") {
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
  } else if (action === "event.save") {
    required(input.name, "o nome do evento ou atração");
    required(input.event_type, "o tipo do evento");
    const open = await db.prepare("SELECT id,data FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
    if (!open) throw new Error("Abra o caixa antes de cadastrar um evento.");
    const cash = JSON.parse(open.data);
    const event = { employee_id: "", employee_name: input.name.trim(), group: "Evento", event_type: input.event_type.trim(), cash_session_id: open.id, work_date: operationalDate(cash.opened_at), daily_rate: amount(input.daily_rate, "o cachê", false), status: "confirmed", note: (input.note || "").trim(), created_at: now(), updated_at: now() };
    await putRecord(db, "staff_shifts", id, event).run();
  } else if (action === "staff.shift.save") {
    const employee = await readRecord(db, "employees", input.employee_id);
    if (!employee) throw new Error("Funcionário não encontrado.");
    const open = await db.prepare("SELECT id,data FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
    if (!open) throw new Error("Abra o caixa antes de montar a equipe deste turno.");
    const cash = JSON.parse(open.data);
    const duplicate = await db.prepare("SELECT id FROM records WHERE kind='staff_shifts' AND json_extract(data,'$.employee_id')=? AND json_extract(data,'$.cash_session_id')=? AND json_extract(data,'$.status')!='cancelled' LIMIT 1").bind(input.employee_id, open.id).first();
    if (duplicate && duplicate.id !== id) throw new Error("Este funcionário já está registrado neste caixa.");
    const shift = { ...(await readRecord(db, "staff_shifts", id) || {}), employee_id: input.employee_id, employee_name: employee.name, group: employee.group, cash_session_id: open.id, work_date: operationalDate(cash.opened_at), daily_rate: amount(input.daily_rate, "a diária", false), status: "confirmed", note: (input.note || "").trim(), updated_at: now() };
    if (!shift.created_at) shift.created_at = now();
    await putRecord(db, "staff_shifts", id, shift).run();
  } else if (action === "staff.shift.pay") {
    const shift = await readRecord(db, "staff_shifts", id);
    if (!shift || shift.status === "cancelled") throw new Error("Pagamento não encontrado.");
    if (shift.status === "paid") throw new Error("Este pagamento já foi realizado.");
    required(input.responsible, "o responsável");
    if (!["Dinheiro", "Pix", "Outro"].includes(input.payment_method)) throw new Error("Forma de pagamento inválida.");
    shift.status = "paid"; shift.payment_method = input.payment_method; shift.paid_at = now(); shift.paid_by = input.responsible.trim(); shift.payment_note = (input.note || "").trim();
    const statements = [putRecord(db, "staff_shifts", id, shift)];
    if (input.payment_method === "Dinheiro") {
      const open = await db.prepare("SELECT id,data FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
      if (!open) throw new Error("Abra o caixa antes de pagar uma diária em dinheiro.");
      const cash = JSON.parse(open.data);
      const paymentLabel = shift.group === "Evento" ? "Cachê" : "Diária";
      cash.movements = [...(cash.movements || []), { id: uid(), type: "withdrawal", amount: Number(shift.daily_rate), responsible: shift.paid_by, note: `${paymentLabel} — ${shift.employee_name}${shift.payment_note ? ` · ${shift.payment_note}` : ""}`, created_at: now(), staff_shift_id: id }];
      statements.push(putRecord(db, "cash", open.id, cash));
    }
    await db.batch(statements);
  } else if (action === "staff.shift.cancel") {
    const shift = await readRecord(db, "staff_shifts", id);
    if (!shift) throw new Error("Diária não encontrada.");
    if (shift.status === "paid") throw new Error("Não é possível cancelar uma diária já paga.");
    shift.status = "cancelled"; shift.cancelled_at = now();
    const accessRows = await db.prepare("SELECT id,data FROM records WHERE kind='staff_access' AND json_extract(data,'$.shift_id')=? AND json_extract(data,'$.revoked_at') IS NULL").bind(id).all();
    const statements = [putRecord(db, "staff_shifts", id, shift)];
    for (const row of accessRows.results) {
      const access = JSON.parse(row.data);
      access.revoked_at = now();
      access.revoked_reason = "shift_cancelled";
      statements.push(putRecord(db, "staff_access", row.id, access));
    }
    await db.batch(statements);
  } else if (action === "staff.access.create") {
    const shift = await readRecord(db, "staff_shifts", id);
    if (!shift || shift.status === "cancelled" || shift.group !== "Adega") throw new Error("O acesso é exclusivo para funcionários da Adega escalados no dia.");
    const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
    if (!open) throw new Error("Abra o caixa antes de gerar o acesso.");
    if (!shift.cash_session_id) {
      const cash = await readRecord(db, "cash", open.id);
      if (shift.work_date !== operationalDate(cash.opened_at)) throw new Error("Este funcionário não está escalado no caixa aberto.");
      shift.cash_session_id = open.id;
      shift.updated_at = now();
      await putRecord(db, "staff_shifts", id, shift).run();
    }
    if (shift.cash_session_id !== open.id) throw new Error("Este funcionário não está escalado no caixa aberto.");
    const rawToken = `${uid()}${uid()}`;
    const accessId = uid();
    const access = { shift_id: id, cash_session_id: open.id, employee_name: shift.employee_name, token_hash: await sha256(rawToken), created_at: now(), expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
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
    const packageSize = input.package_size === "" || input.package_size == null ? null : stockNumber(input.package_size, "o conteúdo da embalagem", false);
    const portionSize = input.portion_size === "" || input.portion_size == null ? null : stockNumber(input.portion_size, "o porcionamento", false);
    const item = { ...(await readRecord(db, "stock_items", id) || {}), name: input.name.trim(), stock_category: ["Comida", "Bebida", "Descartável"].includes(input.stock_category) ? input.stock_category : "Bebida", unit: (input.unit || "un").trim(), package_size: packageSize, package_measure: packageSize == null ? "" : (input.package_measure || "ml").trim(), portion_size: portionSize, portion_measure: portionSize == null ? "" : (input.portion_measure || input.package_measure || "ml").trim(), stock_minimum: stockNumber(input.stock_minimum || 0, "o estoque mínimo"), cost_price: amount(input.cost_price || 0, "o custo"), sku: (input.sku || "").trim(), barcode: (input.barcode || "").trim(), supplier: (input.supplier || "").trim(), updated_at: now() };
    if (input.purchase_unit) item.purchase_unit = String(input.purchase_unit).trim();
    if (input.units_per_package != null && input.units_per_package !== "") { const units = Number(input.units_per_package); if (!Number.isInteger(units) || units <= 0) throw new Error("As unidades por embalagem devem ser um número inteiro maior que zero."); item.units_per_package = units; }
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
  } else if (action === "stock.purchase.batch") {
    required(input.responsible, "o responsável");
    const lines = Array.isArray(input.items) ? input.items : [];
    if (!lines.length || lines.length > 50) throw new Error("A compra deve ter entre 1 e 50 produtos.");
    const statements = [], usedIds = new Set(), purchaseId = uid();
    let created = 0, totalUnits = 0, totalCost = 0;
    for (const [index, line] of lines.entries()) {
      const itemId = line.id || uid();
      if (usedIds.has(itemId)) throw new Error("O mesmo produto foi adicionado mais de uma vez. Edite a linha existente.");
      usedIds.add(itemId);
      let item = line.id ? await readRecord(db, "stock_items", itemId) : null;
      if (line.id && !item) throw new Error(`Produto ${index + 1} não encontrado.`);
      if (!item) {
        required(line.name, `o nome do produto ${index + 1}`);
        item = { name: line.name.trim(), stock_category: ["Comida", "Bebida", "Descartável"].includes(line.stock_category) ? line.stock_category : "Bebida", unit: (line.unit || "un").trim(), package_size: null, package_measure: "", portion_size: null, portion_measure: "", stock_minimum: stockNumber(line.stock_minimum || 0, `o estoque mínimo de ${line.name}`), cost_price: 0, sku: "", barcode: "", supplier: "", stock_quantity: 0, created_at: now() };
        created += 1;
      }
      const packageQuantity = stockNumber(line.package_quantity, `a quantidade de embalagens do produto ${item.name}`, false);
      const unitsPerPackage = Number(line.units_per_package);
      if (!Number.isInteger(unitsPerPackage) || unitsPerPackage <= 0) throw new Error(`Informe as unidades por embalagem de ${item.name}.`);
      const stockUnit = item.unit || "un";
      const packaged = ["package", "fardo"].includes(line.purchase_unit);
      const bulkPackage = packaged && ["kg", "g", "L", "ml"].includes(stockUnit);
      let contentPerUnit = bulkPackage ? stockNumber(line.content_per_unit, `o conteúdo de cada unidade de ${item.name}`, false) : 1;
      const contentUnit = String(line.content_unit || stockUnit).trim();
      if (bulkPackage && contentUnit !== stockUnit) {
        const converted = UNIT_FACTORS[contentUnit]?.[stockUnit];
        if (!converted) throw new Error(`Não é possível converter ${contentUnit} para ${stockUnit} em ${item.name}.`);
        contentPerUnit *= converted;
      }
      const movementQuantity = packageQuantity * unitsPerPackage * contentPerUnit;
      const hasCost = line.package_cost !== "" && line.package_cost != null;
      const entryCost = hasCost ? amount(line.package_cost, `o valor por ${stockUnit} de ${item.name}`) : null;
      const purchaseTotal = entryCost == null ? 0 : Math.round(entryCost * movementQuantity * 100) / 100;
      const balance = line.id ? await db.prepare("SELECT quantity FROM stock_balances WHERE id=?").bind(itemId).first() : null;
      const current = Number(balance?.quantity || 0);
      item.purchase_unit = String(line.purchase_unit || "un").trim();
      item.units_per_package = unitsPerPackage;
      if (bulkPackage) { item.package_size = Number(line.content_per_unit); item.package_measure = contentUnit; }
      item.updated_at = now();
      if (entryCost != null) {
        item.cost_price = Math.round(((current * Number(item.cost_price || 0) + movementQuantity * entryCost) / (current + movementQuantity)) * 100) / 100;
        item.last_cost_price = entryCost;
      }
      statements.push(putRecord(db, "stock_items", itemId, item));
      if (!line.id) statements.push(db.prepare("INSERT INTO stock_balances(id,quantity) VALUES(?,0)").bind(itemId));
      statements.push(...atomicStockChange(db, itemId, item, "in", movementQuantity, { unit_cost: entryCost ?? item.cost_price, responsible: input.responsible, reason: (input.note || "Compra em lote").trim(), reference_id: purchaseId }));
      totalUnits += movementQuantity;
      totalCost += purchaseTotal;
    }
    statements.push(putRecord(db, "stock_purchases", purchaseId, { responsible: input.responsible.trim(), note: (input.note || "").trim(), items_count: lines.length, total_units: totalUnits, total_cost: Math.round(totalCost * 100) / 100, created_at: now() }));
    await db.batch(statements);
    return reply({ ok: true, id: purchaseId, items_count: lines.length, created, total_units: totalUnits, total_cost: Math.round(totalCost * 100) / 100 });
  } else if (action === "stock.item.move") {
    const item = await readRecord(db, "stock_items", id);
    if (!item) throw new Error("Insumo não encontrado.");
    if (!["in", "loss", "adjustment"].includes(input.type)) throw new Error("Tipo de movimentação inválido.");
    required(input.responsible, "o responsável");
    required(input.reason, "o motivo");
    const balance = await db.prepare("SELECT quantity FROM stock_balances WHERE id=?").bind(id).first();
    const current = Number(balance?.quantity || 0);
    const desired = input.type === "adjustment" ? stockNumber(input.new_balance, "o novo saldo") : null;
    const movementType = input.type === "adjustment" ? (desired >= current ? "adjustment_in" : "out") : input.type;
    const movementQty = input.type === "adjustment" ? Math.abs(desired - current) : input.quantity;
    if (Number(movementQty) === 0) throw new Error("O novo saldo é igual ao saldo atual.");
    if (input.type === "in" && input.purchase_unit) item.purchase_unit = String(input.purchase_unit).trim();
    if (input.type === "in" && input.units_per_package != null && input.units_per_package !== "") { const units = Number(input.units_per_package); if (!Number.isInteger(units) || units <= 0) throw new Error("As unidades por embalagem devem ser um número inteiro maior que zero."); item.units_per_package = units; }
    if (input.type === "in" && input.unit_cost !== "" && input.unit_cost != null) {
      const entryCost = amount(input.unit_cost, "o custo");
      item.cost_price = Math.round(((current * Number(item.cost_price || 0) + Number(movementQty) * entryCost) / (current + Number(movementQty))) * 100) / 100;
      item.last_cost_price = entryCost;
    }
    const atomic = atomicStockChange(db, id, item, movementType, movementQty, input);
    await db.batch([putRecord(db, "stock_items", id, item), ...atomic]);
  } else if (action === "stock.invoice.import") {
    required(input.invoice_key, "a chave da nota fiscal");
    required(input.responsible, "o responsável pela importação");
    if (await readRecord(db, "invoice_imports", input.invoice_key)) throw new Error("Este documento já foi importado.");
    const invoiceItems = Array.isArray(input.items) ? input.items : [];
    if (!invoiceItems.length || invoiceItems.length > 80) throw new Error("A nota deve conter entre 1 e 80 produtos.");
    const existingRows = await db.prepare("SELECT id,data FROM records WHERE kind='stock_items'").all();
    const balanceRows = await db.prepare("SELECT id,quantity FROM stock_balances").all();
    const balances = new Map(balanceRows.results.map((row) => [row.id, Number(row.quantity || 0)]));
    const existing = existingRows.results.map((row) => ({ id: row.id, item: JSON.parse(row.data) }));
    const byBarcode = new Map(existing.filter(({ item }) => item.barcode).map((entry) => [String(entry.item.barcode), entry]));
    const bySku = new Map(existing.filter(({ item }) => item.sku).map((entry) => [String(entry.item.sku), entry]));
    const byName = new Map(existing.map((entry) => [String(entry.item.name || "").trim().toLocaleLowerCase(), entry]));
    const statements = [];
    let created = 0, updated = 0;
    for (const source of invoiceItems) {
      required(source.name, "o nome de todos os produtos da nota");
      const qty = stockNumber(source.quantity, `a quantidade de ${source.name}`, false);
      const entryCost = amount(source.unit_cost || 0, `o custo de ${source.name}`);
      const barcode = String(source.barcode || "").trim(), sku = String(source.sku || "").trim(), nameKey = String(source.name).trim().toLocaleLowerCase();
      const match = (barcode && byBarcode.get(barcode)) || (sku && bySku.get(sku)) || byName.get(nameKey);
      const stockItemId = match?.id || uid(), current = balances.get(stockItemId) || 0;
      const item = { ...(match?.item || {}), name: match?.item.name || String(source.name).trim(), unit: String(source.unit || match?.item.unit || "un").trim(), stock_minimum: Number(match?.item.stock_minimum || 0), sku: sku || match?.item.sku || "", barcode: barcode || match?.item.barcode || "", supplier: String(input.supplier || match?.item.supplier || "").trim(), updated_at: now() };
      item.cost_price = Math.round(((current * Number(match?.item.cost_price || 0) + qty * entryCost) / (current + qty)) * 100) / 100;
      item.last_cost_price = entryCost;
      if (!item.created_at) item.created_at = now();
      statements.push(putRecord(db, "stock_items", stockItemId, item));
      if (!match) statements.push(db.prepare("INSERT OR IGNORE INTO stock_balances(id,quantity) VALUES(?,0)").bind(stockItemId));
      const documentLabel = input.source_type === "pdf" ? "pedido" : "NF-e";
      statements.push(...atomicStockChange(db, stockItemId, item, "in", qty, { unit_cost: entryCost, reason: `Entrada pelo ${documentLabel} ${input.invoice_number || input.invoice_key}`, responsible: input.responsible, reference_id: input.invoice_key }));
      const indexed = { id: stockItemId, item };
      if (barcode) byBarcode.set(barcode, indexed);
      if (sku) bySku.set(sku, indexed);
      byName.set(nameKey, indexed);
      balances.set(stockItemId, current + qty);
      if (match) updated += 1; else created += 1;
    }
    statements.push(putRecord(db, "invoice_imports", input.invoice_key, { invoice_key: input.invoice_key, invoice_number: String(input.invoice_number || "").trim(), supplier: String(input.supplier || "").trim(), products_count: invoiceItems.length, created, updated, imported_by: input.responsible.trim(), created_at: now() }));
    await db.batch(statements);
    return reply({ ok: true, id: input.invoice_key, created, updated, products_count: invoiceItems.length });
  } else if (action === "recipe.save") {
    const menuItem = await readRecord(db, "menu", id);
    if (!menuItem) throw new Error("Produto do cardápio não encontrado.");
    const components = Array.isArray(input.components) ? input.components : [];
    const componentTotals = new Map();
    for (const component of components) {
      const stockItem = await readRecord(db, "stock_items", component.stock_item_id);
      if (!stockItem) throw new Error("Um dos insumos selecionados não existe.");
      const stockUnit = stockItem.unit || "un", inputUnit = component.unit || stockUnit, normalizedQuantity = recipeQuantity(component.quantity, inputUnit, stockUnit, stockItem), current = componentTotals.get(component.stock_item_id);
      componentTotals.set(component.stock_item_id, current ? { quantity: current.quantity + normalizedQuantity, input_quantity: current.quantity + normalizedQuantity, input_unit: stockUnit } : { quantity: normalizedQuantity, input_quantity: Number(component.quantity), input_unit: inputUnit });
    }
    const normalized = [...componentTotals].map(([stock_item_id, component]) => ({ stock_item_id, quantity: Math.round(component.quantity * 10000) / 10000, input_quantity: component.input_quantity, input_unit: component.input_unit }));
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
    if (!["in", "loss", "adjustment"].includes(input.type)) throw new Error("Tipo de movimentação inválido.");
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
    const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
    const accountType = !admin ? "tab" : input.account_type === "tab" ? "tab" : input.account_type === "owner" ? "owner" : "customer";
    if (accountType === "tab" && !open) throw new Error("Abra o caixa antes de abrir uma comanda.");
    await putRecord(db, "accounts", id, { account_type: accountType, customer_name: input.customer_name.trim(), note: (input.note || "").trim(), opening_balance: accountType === "tab" ? 0 : amount(input.opening_balance || 0, "o saldo inicial"), opening_balance_at: now(), cash_session_id: accountType === "tab" ? open.id : "", status: accountType === "tab" ? "open" : undefined, items: [], payments_total: 0, created_at: now() }).run();
  } else if (action === "account.update") {
    const account = await readRecord(db, "accounts", id);
    if (!account) throw new Error("Fiado não encontrado.");
    if (!admin && account.account_type !== "tab") throw new Error("O fiado está disponível somente no Admin.");
    required(input.customer_name, "o nome do cliente");
    account.customer_name = input.customer_name.trim();
    account.account_type = account.account_type === "tab" ? "tab" : input.account_type === "owner" ? "owner" : "customer";
    account.note = (input.note || "").trim();
    delete account.credit_limit;
    delete account.blocked;
    delete account.phone;
    delete account.due_days;
    account.updated_at = now();
    await putRecord(db, "accounts", id, account).run();
  } else if (action === "account.addItem") {
    const account = await readRecord(db, "accounts", id);
    if (!account) throw new Error("Conta não encontrada.");
    if (!admin && account.account_type !== "tab") throw new Error("O fiado está disponível somente no Admin.");
    required(input.description, "o item");
    const createdAt = now();
    const orderId = uid();
    const origin = await orderOrigin(db, input.origin_token);
    const entry = { id: uid(), menu_id: input.menu_id || "", description: input.description.trim(), quantity: quantity(input.quantity), price: amount(input.price, "o preço"), note: (input.note || "").trim(), created_at: createdAt, order_id: orderId, created_by: origin.source_name, created_source_type: origin.source_type, created_shift_id: origin.source_shift_id || "", stock_usage: [] };
    if (entry.menu_id) entry.stock_usage = await recipeUsage(db, entry.menu_id, entry.quantity);
    if (account.account_type === "owner" && entry.menu_id) {
      const menuItem = await readRecord(db, "menu", entry.menu_id);
      const totalCost = entry.stock_usage.length ? entry.stock_usage.reduce((sum, usage) => sum + Number(usage.quantity || 0) * Number(usage.unit_cost || 0), 0) : Number(menuItem?.cost_price || 0) * entry.quantity;
      if (totalCost <= 0) throw new Error(`Configure o custo ou os insumos de ${entry.description} antes de lançar na ficha de proprietário.`);
      entry.price = Math.round(totalCost / entry.quantity * 100) / 100;
    }
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
        const movement = stockMovement(db, entry.menu_id, product, "sale", entry.quantity, { reason: "Consumo no fiado", responsible: "Sistema", reference_id: orderId, legacy_menu: true });
        statements.push(putRecord(db, "menu", entry.menu_id, product), movement);
      }
    }
    if (input.print_order || input.send_to_kitchen) statements.push(putRecord(db, "kitchen", uid(), { ...entry, customer_name: account.customer_name, note: (input.note || "").trim(), origin: "Fiado", status: "pending", print_status: "pending", print_count: 0 }));
    await db.batch(statements);
  } else if (action === "account.cancelItem") {
    const account = await readRecord(db, "accounts", id);
    if (!account) throw new Error("Conta não encontrada.");
    if (!admin && account.account_type !== "tab") throw new Error("O fiado está disponível somente no Admin.");
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
    if (!admin && account.account_type !== "tab") throw new Error("O fiado está disponível somente no Admin.");
    const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
    if (!open) throw new Error(`Abra o caixa antes de receber ${account.account_type === "tab" ? "uma comanda" : "um fiado"}.`);
    if (account.account_type === "tab" && account.cash_session_id !== open.id) throw new Error("Esta comanda pertence a outro caixa.");
    required(input.payment_method, "a forma de pagamento");
    let paymentMethod = input.payment_method;
    if (paymentMethod === "Cartão") {
      if (!["Débito", "Crédito"].includes(input.card_type)) throw new Error("Escolha Débito ou Crédito para o pagamento em cartão.");
      paymentMethod = `Cartão - ${input.card_type}`;
    } else if (!["Dinheiro", "Pix"].includes(paymentMethod)) throw new Error("Forma de pagamento inválida.");
    let paymentResponsible;
    if (account.account_type === "tab") {
      const origin = input.origin_token ? await orderOrigin(db, input.origin_token) : null;
      paymentResponsible = origin?.source_name || device?.label || "Caixa principal";
    } else {
      required(input.responsible, "o responsável pelo recebimento");
      paymentResponsible = input.responsible.trim();
    }
    const received = amount(input.amount, "um valor", false);
    const balance = accountBalance(account);
    if (received > balance + 0.001) throw new Error(`O valor informado é maior que o saldo de R$ ${balance.toFixed(2).replace('.', ',')}.`);
    const settlementType = ["equal", "items"].includes(input.settlement_type) ? input.settlement_type : "free";
    let allocations = [];
    if (settlementType === "items") {
      const requested = Array.isArray(input.allocations) ? input.allocations : [];
      if (!requested.length) throw new Error("Selecione ao menos um item para receber.");
      const previousRows = await db.prepare("SELECT data FROM records WHERE kind='account_payments' AND json_extract(data,'$.account_id')=?").bind(id).all();
      if (previousRows.results.some((row) => !JSON.parse(row.data).voided_at)) throw new Error("O pagamento por itens só está disponível antes do primeiro pagamento deste fiado.");
      const previouslyPaid = new Map();
      for (const row of previousRows.results) {
        const previous = JSON.parse(row.data);
        if (previous.voided_at) continue;
        for (const allocation of previous.allocations || []) previouslyPaid.set(allocation.item_id, (previouslyPaid.get(allocation.item_id) || 0) + Number(allocation.quantity || 0));
      }
      const itemMap = new Map((account.items || []).filter((item) => !item.cancelled_at).map((item) => [item.id, item]));
      allocations = requested.map((allocation) => {
        const item = itemMap.get(allocation.item_id);
        if (!item) throw new Error("Um dos itens selecionados não está mais disponível.");
        const selectedQuantity = Number(allocation.quantity);
        if (!Number.isInteger(selectedQuantity) || selectedQuantity <= 0) throw new Error("Informe quantidades inteiras maiores que zero.");
        const availableQuantity = Number(item.quantity || 0) - Number(previouslyPaid.get(item.id) || 0);
        if (selectedQuantity > availableQuantity) throw new Error(`A quantidade selecionada de ${item.description} é maior que a quantidade pendente.`);
        return { item_id: item.id, description: item.description, quantity: selectedQuantity, unit_price: Number(item.price), amount: Math.round(selectedQuantity * Number(item.price) * 100) / 100 };
      });
      const allocationTotal = Math.round(allocations.reduce((sum, allocation) => sum + allocation.amount, 0) * 100) / 100;
      if (Math.abs(allocationTotal - received) > 0.001) throw new Error("O valor recebido não corresponde aos itens selecionados.");
    }
    const paymentId = uid();
    const createdAt = now();
    const payment = { account_id: id, customer_name: account.customer_name, amount: received, payment_method: paymentMethod, card_type: input.card_type || "", responsible: paymentResponsible, note: (input.note || "").trim(), settlement_type: settlementType, split_people: settlementType === "equal" ? Math.max(2, Number(input.split_people || 2)) : null, allocations, cash_session_id: open.id, created_at: createdAt };
    const remainingBalance = Math.max(0, Math.round((balance - received) * 100) / 100);
    account.payments_total = Math.round((Number(account.payments_total || 0) + received) * 100) / 100;
    account.last_payment_at = createdAt;
    if (remainingBalance <= 0.001) { account.closed_at = createdAt; if (account.account_type === "tab") account.status = "closed"; }
    await db.batch([putRecord(db, "accounts", id, account), putRecord(db, "account_payments", paymentId, payment)]);
    return reply({ ok: true, id: paymentId, balance_after: remainingBalance, closed: remainingBalance <= 0.001 });
  } else if (action === "account.convertToCredit") {
    const tab = await readRecord(db, "accounts", id);
    if (!tab || tab.account_type !== "tab" || tab.status === "closed") throw new Error("Comanda aberta não encontrada.");
    const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
    if (!open || tab.cash_session_id !== open.id) throw new Error("Esta comanda não pertence ao caixa aberto.");
    const balance = accountBalance(tab);
    if (balance <= 0.001) throw new Error("Esta comanda não possui saldo para transferir.");
    let creditId = input.credit_account_id || uid();
    let credit = input.credit_account_id ? await readRecord(db, "accounts", creditId) : null;
    if (input.credit_account_id && !credit) throw new Error("A ficha de fiado escolhida não foi encontrada.");
    if (credit && credit.account_type === "tab") throw new Error("Escolha uma ficha de fiado válida.");
    if (!credit) { required(input.customer_name, "o nome da nova ficha de fiado"); credit = { account_type: "customer", customer_name: input.customer_name.trim(), note: (input.note || "").trim(), opening_balance: 0, opening_balance_at: now(), items: [], payments_total: 0, created_at: now() }; }
    const createdAt = now(), transferItem = { id: uid(), description: `Saldo transferido da comanda ${tab.customer_name}`, quantity: 1, price: balance, note: (input.note || "").trim(), created_at: createdAt, order_id: uid(), created_by: input.responsible?.trim() || "Caixa principal", source_tab_id: id };
    credit.items = [...(credit.items || []), transferItem];
    tab.payments_total = Math.round((Number(tab.payments_total || 0) + balance) * 100) / 100;
    tab.status = "closed"; tab.closed_at = createdAt; tab.converted_to_account_id = creditId;
    const transfer = { account_id: id, customer_name: tab.customer_name, amount: balance, payment_method: "Transferido para fiado", responsible: input.responsible?.trim() || "Caixa principal", note: (input.note || "").trim(), settlement_type: "transfer", converted_account_id: creditId, created_at: createdAt };
    await db.batch([putRecord(db, "accounts", id, tab), putRecord(db, "accounts", creditId, credit), putRecord(db, "account_payments", uid(), transfer)]);
    return reply({ ok: true, id: creditId, closed: true });
  } else if (action === "stock.event.create") {
    if (!["loss", "courtesy"].includes(input.event_type)) throw new Error("Escolha Perda ou Cortesia.");
    required(input.responsible, "o responsável");
    const items = await cartItems(db, input.items);
    const withoutRecipe = items.filter((item) => !item.stock_usage.length);
    if (withoutRecipe.length) throw new Error(`Configure a baixa de estoque antes de registrar: ${withoutRecipe.map((item) => item.description).join(", ")}.`);
    const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
    if (!open) throw new Error("Abra o caixa antes de registrar uma perda ou cortesia.");
    const origin = await orderOrigin(db, input.origin_token), createdAt = now(), eventId = id, requirements = new Map(), eventItems = [];
    for (const item of items) {
      const usage = item.stock_usage.map((component) => ({ ...component, quantity: Math.round(Number(component.quantity) * item.quantity * 10000) / 10000 }));
      for (const component of usage) requirements.set(component.stock_item_id, (requirements.get(component.stock_item_id) || 0) + component.quantity);
      eventItems.push({ menu_id: item.menu_id, description: item.description, quantity: item.quantity, sale_price: item.price, stock_usage: usage, cost: Math.round(usage.reduce((sum, component) => sum + component.quantity * Number(component.unit_cost || 0), 0) * 100) / 100 });
    }
    const statements = [], movementType = input.event_type === "loss" ? "loss" : "courtesy", label = input.event_type === "loss" ? "Perda" : "Cortesia", reason = (input.reason || "").trim();
    for (const [stockItemId, requiredQuantity] of requirements) {
      const stockItem = await readRecord(db, "stock_items", stockItemId), balance = await db.prepare("SELECT quantity FROM stock_balances WHERE id=?").bind(stockItemId).first();
      if (!stockItem) throw new Error("Um insumo da ficha técnica não existe mais.");
      if (Number(balance?.quantity || 0) + .000001 < requiredQuantity) throw new Error(`Estoque insuficiente de ${stockItem.name}. Disponível: ${Number(balance?.quantity || 0)} ${stockItem.unit || "un"}.`);
      statements.push(...atomicStockChange(db, stockItemId, stockItem, movementType, requiredQuantity, { reason: reason ? `${label}: ${reason}` : label, responsible: input.responsible.trim(), reference_id: eventId }));
    }
    const event = { event_type: input.event_type, responsible: input.responsible.trim(), reason: reason || label, beneficiary: (input.beneficiary || "").trim(), items: eventItems, items_count: eventItems.length, units_count: eventItems.reduce((sum, item) => sum + item.quantity, 0), total_cost: Math.round(eventItems.reduce((sum, item) => sum + item.cost, 0) * 100) / 100, revenue_not_realized: Math.round(eventItems.reduce((sum, item) => sum + item.quantity * item.sale_price, 0) * 100) / 100, cash_session_id: origin.cash_session_id || open.id, created_at: createdAt, created_by: origin.source_name, created_source_type: origin.source_type, created_shift_id: origin.source_shift_id || "" };
    statements.push(putRecord(db, "stock_events", eventId, event));
    await db.batch(statements);
    return reply({ ok: true, id: eventId, total_cost: event.total_cost });
  } else if (action === "stock.event.cancel") {
    required(input.responsible, "o responsável pelo cancelamento"); required(input.reason, "a justificativa do cancelamento");
    const event = await readRecord(db, "stock_events", id);
    if (!event || event.cancelled_at) throw new Error("Ocorrência não encontrada ou já cancelada.");
    const statements = [];
    for (const item of event.items || []) for (const usage of item.stock_usage || []) {
      const stockItem = await readRecord(db, "stock_items", usage.stock_item_id);
      if (stockItem) statements.push(...atomicStockChange(db, usage.stock_item_id, stockItem, "return", usage.quantity, { reason: `Cancelamento de ${event.event_type === "loss" ? "perda" : "cortesia"}: ${input.reason.trim()}`, responsible: input.responsible.trim(), reference_id: id }));
    }
    event.cancelled_at = now(); event.cancelled_by = input.responsible.trim(); event.cancel_reason = input.reason.trim();
    statements.push(putRecord(db, "stock_events", id, event)); await db.batch(statements);
  } else if (action === "hosted.event.save") {
    required(input.name, "o nome do evento");
    const eventMode = input.event_mode === "contracted" ? "contracted" : "hosted";
    const allowance = Number(input.allowance);
    if (!Number.isFinite(allowance) || allowance < 0) throw new Error("Informe um limite de consumação válido.");
    const existing = input.id ? await readRecord(db, "hosted_events", id) : null;
    if (input.id && !existing) throw new Error("Evento não encontrado.");
    if (existing?.status === "closed") throw new Error("Um evento encerrado não pode ser alterado.");
    if (existing?.event_mode && existing.event_mode !== eventMode) throw new Error("O tipo de um evento já cadastrado não pode ser alterado.");
    const open = await db.prepare("SELECT id,data FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
    if (!existing && !open) throw new Error("Abra o caixa antes de cadastrar um evento.");
    const eventCashSessionId = existing?.cash_session_id || open?.id;
    if (existing && allowance + 0.001 < Number(existing.used_amount || 0)) throw new Error("O limite não pode ser menor que a consumação já utilizada.");
    const statements = [];
    let feeShiftId = existing?.fee_shift_id || "";
    let feeAmount = Number(input.fee_amount || 0);
    if (eventMode === "contracted") {
      if (!Number.isFinite(feeAmount) || feeAmount <= 0) throw new Error("Informe um cachê válido.");
      if (!open && !feeShiftId) throw new Error("Abra o caixa antes de contratar uma atração.");
      const currentShift = feeShiftId ? await readRecord(db, "staff_shifts", feeShiftId) : null;
      if (currentShift?.status === "paid" && Math.abs(Number(currentShift.daily_rate) - feeAmount) > 0.001) throw new Error("O cachê já foi pago e não pode ter o valor alterado.");
      feeShiftId ||= uid();
      const cash = open ? JSON.parse(open.data) : null;
      const shift = { ...(currentShift || {}), employee_id: "", employee_name: input.name.trim(), group: "Evento", event_type: "Atração", cash_session_id: currentShift?.cash_session_id || open?.id, work_date: currentShift?.work_date || operationalDate(cash.opened_at), daily_rate: feeAmount, status: currentShift?.status || "confirmed", note: (input.note || "").trim(), hosted_event_id: id, updated_at: now() };
      if (!shift.created_at) shift.created_at = now();
      statements.push(putRecord(db, "staff_shifts", feeShiftId, shift));
    } else feeAmount = 0;
    const hostedEvent = { ...(existing || {}), event_mode: eventMode, name: input.name.trim(), organizer: "", attraction_type: "", fee_amount: feeAmount, fee_shift_id: feeShiftId, allowance, starts_at: "", ends_at: "", cash_session_id: eventCashSessionId, allow_overage: eventMode === "hosted" && input.allow_overage === true, note: (input.note || "").trim(), status: existing?.status || "open", used_amount: Number(existing?.used_amount || 0), orders: existing?.orders || [] };
    hostedEvent[existing ? "updated_at" : "created_at"] = now();
    statements.push(putRecord(db, "hosted_events", id, hostedEvent));
    await db.batch(statements);
  } else if (action === "hosted.event.close") {
    const hostedEvent = await readRecord(db, "hosted_events", id);
    if (!hostedEvent || hostedEvent.status === "closed") throw new Error("Evento não encontrado ou já encerrado.");
    hostedEvent.status = "closed"; hostedEvent.closed_at = now(); hostedEvent.closed_by = (input.responsible || "Admin").trim();
    await putRecord(db, "hosted_events", id, hostedEvent).run();
  } else if (action === "sale.checkout") {
    if (!admin && (input.destination === "account" || input.to_account === true)) throw new Error("O fiado está disponível somente no Admin. Use uma comanda.");
    const items = await cartItems(db, input.items);
    const createdAt = now();
    const origin = await orderOrigin(db, input.origin_token);
    const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' ORDER BY created_at DESC LIMIT 1").first();
    if (!open) throw new Error("Abra o caixa no Admin antes de registrar pedidos.");
    const cashSessionId = origin.cash_session_id || open.id;
    const customerName = (input.customer_name || "").trim();
    const note = (input.note || "").trim();
    const statements = [];
    const foodItems = items.filter((item) => item.category === "Comidas");
    const shouldPrint = foodItems.length > 0;
    const orderId = id;

    if (input.destination === "account" || input.destination === "tab" || input.to_account === true) {
      const accountId = input.account_id || uid();
      let account = await readRecord(db, "accounts", accountId);
      if (!account) {
        required(customerName, input.destination === "tab" ? "o nome para abrir a comanda" : "o cliente para criar o fiado");
        account = input.destination === "tab"
          ? { account_type: "tab", customer_name: customerName, note: "", opening_balance: 0, created_at: createdAt, cash_session_id: cashSessionId, status: "open", items: [], payments_total: 0 }
          : { account_type: input.account_type === "owner" ? "owner" : "customer", customer_name: customerName, note: "", opening_balance: 0, created_at: createdAt.slice(0, 10), items: [], payments_total: 0 };
      }
      if (input.destination === "tab" && (account.account_type !== "tab" || account.cash_session_id !== cashSessionId || account.status === "closed")) throw new Error("Escolha uma comanda aberta deste caixa.");
      const orderCustomerName = String(account.customer_name || customerName).trim();
      required(orderCustomerName, "o nome do cliente da comanda");
      const accountEntries = items.map((item) => { const ownerCost = item.stock_usage.length ? item.stock_usage.reduce((sum, usage) => sum + Number(usage.quantity || 0) * Number(usage.unit_cost || 0), 0) : Number(item.menu_item?.cost_price || 0); if (account.account_type === "owner" && ownerCost <= 0) throw new Error(`Configure o custo ou os insumos de ${item.description} antes de lançar na ficha de proprietário.`); return { id: uid(), menu_id: item.menu_id, item_category: item.category, stock_usage: item.stock_usage.map((usage) => ({ ...usage, quantity: Number(usage.quantity) * item.quantity })), description: item.description, quantity: item.quantity, price: account.account_type === "owner" ? Math.round(ownerCost * 100) / 100 : item.price, note: item.note, created_at: createdAt, order_id: orderId, cash_session_id: cashSessionId, created_by: origin.source_name, created_source_type: origin.source_type, created_shift_id: origin.source_shift_id || "" }; });
      account.items = [...(account.items || []), ...accountEntries];
      statements.push(putRecord(db, "accounts", accountId, account));
      for (const entry of accountEntries) statements.push(putRecord(db, "sales", uid(), { menu_id: entry.menu_id, item_category: entry.item_category, stock_usage: entry.stock_usage, description: entry.description, quantity: entry.quantity, price: entry.price, item_note: entry.note, note, customer_name: orderCustomerName, payment_method: account.account_type === "tab" ? "Comanda" : "Caderneta", account_id: accountId, account_type: account.account_type || "customer", account_item_id: entry.id, cash_session_id: cashSessionId, order_id: orderId, created_at: createdAt, ...origin }));
      if (shouldPrint) statements.push(putRecord(db, "kitchen", orderId, { items: foodItems, description: `${foodItems.length} itens`, quantity: foodItems.reduce((sum, item) => sum + item.quantity, 0), customer_name: orderCustomerName, account_id: accountId, account_type: account.account_type || "customer", cash_session_id: cashSessionId, note, origin: account.account_type === "tab" ? "Comanda" : "Fiado", created_at: createdAt, status: "pending", print_status: "pending", print_count: 0, created_by: origin.source_name, created_source_type: origin.source_type, created_shift_id: origin.source_shift_id || "" }));
    } else if (input.destination === "event") {
      required(input.event_id, "o evento");
      const hostedEvent = await readRecord(db, "hosted_events", input.event_id);
      if (!hostedEvent || hostedEvent.status !== "open") throw new Error("Este evento não está disponível.");
      if (hostedEvent.cash_session_id && hostedEvent.cash_session_id !== cashSessionId) throw new Error("Este evento pertence a outro caixa.");
      const orderTotal = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
      const remaining = Math.max(0, Number(hostedEvent.allowance || 0) - Number(hostedEvent.used_amount || 0));
      const covered = Math.min(orderTotal, remaining);
      const overage = Math.max(0, orderTotal - covered);
      if (overage > 0.001 && !hostedEvent.allow_overage) throw new Error(`O saldo do evento é ${remaining.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}. O excedente não está autorizado.`);
      let paymentMethod = "Consumação de evento";
      if (overage > 0.001) {
        required(input.payment_method, "a forma de pagamento do excedente"); paymentMethod = input.payment_method;
        if (paymentMethod === "Cartão") {
          if (!["Débito", "Crédito"].includes(input.card_type)) throw new Error("Escolha Débito ou Crédito para o pagamento em cartão.");
          paymentMethod = `Cartão - ${input.card_type}`;
        } else if (!["Dinheiro", "Pix"].includes(paymentMethod)) throw new Error("Forma de pagamento inválida.");
      }
      const revenueRatio = orderTotal > 0 ? overage / orderTotal : 0;
      const actualCost = items.reduce((sum, item) => sum + (item.stock_usage.length ? item.stock_usage.reduce((itemCost, usage) => itemCost + Number(usage.quantity || 0) * item.quantity * Number(usage.unit_cost || 0), 0) : Number(item.menu_item.cost_price || 0) * item.quantity), 0);
      for (const item of items) statements.push(putRecord(db, "sales", uid(), { menu_id: item.menu_id, item_category: item.category, stock_usage: item.stock_usage.map((usage) => ({ ...usage, quantity: Number(usage.quantity) * item.quantity })), description: item.description, quantity: item.quantity, price: item.price * revenueRatio, menu_price: item.price, event_consumption_amount: item.quantity * item.price * (1 - revenueRatio), item_note: item.note, note, customer_name: hostedEvent.name, payment_method: paymentMethod, card_type: overage > 0.001 ? input.card_type || "" : "", hosted_event_id: input.event_id, cash_session_id: cashSessionId, order_id: orderId, created_at: createdAt, ...origin }));
      hostedEvent.used_amount = Number(hostedEvent.used_amount || 0) + covered;
      hostedEvent.actual_cost = Number(hostedEvent.actual_cost || 0) + actualCost;
      hostedEvent.orders = [...(hostedEvent.orders || []), { id: orderId, items: items.map(item => ({ menu_id: item.menu_id, description: item.description, quantity: item.quantity, unit_price: item.price, note: item.note })), order_total: orderTotal, covered_amount: covered, overage_amount: overage, actual_cost: actualCost, payment_method: paymentMethod, created_at: createdAt, created_by: origin.source_name }];
      statements.push(putRecord(db, "hosted_events", input.event_id, hostedEvent));
      if (shouldPrint) statements.push(putRecord(db, "kitchen", orderId, { items: foodItems, description: `${foodItems.length} itens`, quantity: foodItems.reduce((sum, item) => sum + item.quantity, 0), customer_name: hostedEvent.name, note, origin: "Consumação de evento", payment_method: paymentMethod, created_at: createdAt, status: "pending", print_status: "pending", print_count: 0, created_by: origin.source_name, created_source_type: origin.source_type, created_shift_id: origin.source_shift_id || "" }));
    } else {
      required(input.payment_method, "a forma de pagamento");
      let paymentMethod = input.payment_method;
      if (paymentMethod === "Cartão") {
        if (!["Débito", "Crédito"].includes(input.card_type)) throw new Error("Escolha Débito ou Crédito para o pagamento em cartão.");
        paymentMethod = `Cartão - ${input.card_type}`;
      } else if (!["Dinheiro", "Pix"].includes(paymentMethod)) throw new Error("Forma de pagamento inválida.");
      if (shouldPrint) required(customerName, "o nome do cliente para enviar o pedido à cozinha");
      for (const item of items) {
        const saleId = uid();
        statements.push(putRecord(db, "sales", saleId, { menu_id: item.menu_id, item_category: item.category, stock_usage: item.stock_usage.map((usage) => ({ ...usage, quantity: Number(usage.quantity) * item.quantity })), description: item.description, quantity: item.quantity, price: item.price, item_note: item.note, note, customer_name: customerName, payment_method: paymentMethod, card_type: input.card_type || "", cash_session_id: cashSessionId, order_id: orderId, created_at: createdAt, ...origin }));
      }
      if (shouldPrint) statements.push(putRecord(db, "kitchen", orderId, { items: foodItems, description: `${foodItems.length} itens`, quantity: foodItems.reduce((sum, item) => sum + item.quantity, 0), customer_name: customerName, note, origin: "Venda", payment_method: paymentMethod, card_type: input.card_type || "", created_at: createdAt, status: "pending", print_status: "pending", print_count: 0, created_by: origin.source_name, created_source_type: origin.source_type, created_shift_id: origin.source_shift_id || "" }));
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
  } else if (action === "sale.order.void") {
    required(input.reason, "a justificativa do cancelamento");
    required(input.responsible, "o responsável pelo cancelamento");
    const rows = await db.prepare("SELECT id,data FROM records WHERE kind='sales' AND json_extract(data,'$.order_id')=?").bind(input.order_id).all();
    const sales = rows.results.map(row => [row.id, JSON.parse(row.data)]).filter(([,sale])=>!sale.voided_at);
    if (!sales.length) throw new Error("Pedido não encontrado ou já cancelado.");
    if (sales.some(([,sale])=>sale.account_id)) throw new Error("Pedidos do fiado devem ser corrigidos dentro da própria ficha.");
    const responsible = input.responsible.trim(), reason = input.reason.trim(), statements = [];
    const hostedEventId = sales.find(([,sale]) => sale.hosted_event_id)?.[1]?.hosted_event_id;
    if (hostedEventId) {
      const hostedEvent = await readRecord(db, "hosted_events", hostedEventId);
      const eventOrder = hostedEvent?.orders?.find(order => order.id === input.order_id && !order.cancelled_at);
      if (eventOrder) { hostedEvent.used_amount = Math.max(0, Number(hostedEvent.used_amount || 0) - Number(eventOrder.covered_amount || 0)); hostedEvent.actual_cost = Math.max(0, Number(hostedEvent.actual_cost || 0) - Number(eventOrder.actual_cost || 0)); eventOrder.cancelled_at = now(); eventOrder.cancelled_by = responsible; eventOrder.cancel_reason = reason; statements.push(putRecord(db, "hosted_events", hostedEventId, hostedEvent)); }
    }
    for (const [saleId,sale] of sales) statements.push(...await voidSaleStatements(db, saleId, sale, responsible, reason));
    const kitchen = await readRecord(db, "kitchen", input.order_id);
    if (kitchen && !["delivered","done"].includes(kitchen.status)) { kitchen.status="cancelled"; kitchen.cancelled_at=now(); kitchen.cancelled_by=responsible; kitchen.cancel_reason=reason; statements.push(putRecord(db,"kitchen",input.order_id,kitchen)); }
    await db.batch(statements);
  } else if (action === "sale.delete") {
    const sale = await readRecord(db, "sales", id);
    if (sale?.account_id) throw new Error("Consumos do fiado não podem ser apagados. Use o cancelamento com responsável e justificativa.");
    await db.prepare("DELETE FROM records WHERE kind='sales' AND id=?").bind(id).run();
  } else if (action === "sale.void") {
    required(input.reason, "a justificativa do cancelamento");
    const sale = await readRecord(db, "sales", id);
    if (!sale) throw new Error("Lançamento não encontrado.");
    if (sale.voided_at) throw new Error("Este lançamento já foi cancelado.");
    if (sale.account_id) throw new Error("Cancele este consumo diretamente no fiado para manter o saldo e o estoque consistentes.");
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
    const projectCode = input.project_code === "bagaco_laranja" ? "bagaco_laranja" : "adega_regular";
    const open = await db.prepare("SELECT id FROM records WHERE kind='cash' AND json_extract(data,'$.status')='open' LIMIT 1").first();
    if (open) throw new Error("Já existe um caixa aberto.");
    await putRecord(db, "cash", id, { status: "open", project_code: projectCode, project_name: projectCode === "bagaco_laranja" ? "Bagaço da Laranja" : "Adega Camisa 10", opened_at: now(), opened_by: input.opened_by.trim(), opening_amount: amount(input.opening_amount, "o valor inicial em dinheiro"), opening_account_amount: amount(input.opening_account_amount || 0, "o saldo inicial da conta"), opening_note: (input.note || "").trim(), movements: [], closed_at: "" }).run();
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
    const kitchenOpen = await db.prepare("SELECT COUNT(*) AS total FROM records WHERE kind='kitchen' AND COALESCE(json_extract(data,'$.status'),'pending') NOT IN ('delivered','done','cancelled')").first();
    const kitchenOpenCount = Number(kitchenOpen?.total || 0);
    if (kitchenOpenCount) throw new Error(`Não é possível fechar o caixa: ${kitchenOpenCount} pedido${kitchenOpenCount === 1 ? "" : "s"} ainda ${kitchenOpenCount === 1 ? "está" : "estão"} em andamento na cozinha.`);
    const openTabs = await db.prepare("SELECT COUNT(*) AS total FROM records WHERE kind='accounts' AND json_extract(data,'$.account_type')='tab' AND json_extract(data,'$.cash_session_id')=? AND COALESCE(json_extract(data,'$.status'),'open')='open'").bind(id).first();
    const openTabCount = Number(openTabs?.total || 0);
    if (openTabCount) throw new Error(`Não é possível fechar o caixa: ${openTabCount} comanda${openTabCount === 1 ? " está" : "s estão"} aberta${openTabCount === 1 ? "" : "s"}. Quite ou transfira ${openTabCount === 1 ? "a comanda" : "as comandas"} para o fiado antes de continuar.`);
    const staffPending = await db.prepare("SELECT COUNT(*) AS total FROM records WHERE kind='staff_shifts' AND json_extract(data,'$.cash_session_id')=? AND COALESCE(json_extract(data,'$.status'),'confirmed') NOT IN ('paid','cancelled')").bind(id).first();
    const staffPendingCount = Number(staffPending?.total || 0);
    if (staffPendingCount) throw new Error(`Não é possível fechar o caixa: ${staffPendingCount} pagamento${staffPendingCount === 1 ? "" : "s"} da equipe ainda ${staffPendingCount === 1 ? "está" : "estão"} pendente${staffPendingCount === 1 ? "" : "s"}. Pague ou cancele ${staffPendingCount === 1 ? "a diária" : "as diárias"} antes de continuar.`);
    required(input.closed_by, "o responsável pelo fechamento");
    const sales = await db.prepare("SELECT data FROM records WHERE kind='sales' AND json_extract(data,'$.cash_session_id')=?").bind(id).all();
    const parsed = sales.results.map((row) => JSON.parse(row.data)).filter((sale) => !sale.voided_at);
    const directSales = parsed.filter((sale) => !sale.account_id && sale.payment_method !== "Caderneta");
    const accountSales = parsed.filter((sale) => sale.account_id || sale.payment_method === "Caderneta");
    const paymentTotals = {};
    for (const sale of directSales) paymentTotals[sale.payment_method || "Não informado"] = (paymentTotals[sale.payment_method || "Não informado"] || 0) + Number(sale.quantity || 0) * Number(sale.price || 0);
    const receiptRows = await db.prepare("SELECT data FROM records WHERE kind='account_payments' AND json_extract(data,'$.cash_session_id')=?").bind(id).all();
    const receipts = receiptRows.results.map((row) => JSON.parse(row.data)).filter((payment) => !payment.voided_at);
    for (const payment of receipts) paymentTotals[payment.payment_method] = (paymentTotals[payment.payment_method] || 0) + Number(payment.amount || 0);
    const supplies = (cash.movements || []).filter((movement) => movement.type === 'supply').reduce((sum, movement) => sum + Number(movement.amount || 0), 0);
    const withdrawals = (cash.movements || []).filter((movement) => movement.type === 'withdrawal').reduce((sum, movement) => sum + Number(movement.amount || 0), 0);
    const expectedCash = Number(cash.opening_amount || 0) + Number(paymentTotals.Dinheiro || 0) + supplies - withdrawals;
    const countedCash = amount(input.counted_cash, "o dinheiro contado");
    const accountReceipts = Object.entries(paymentTotals).filter(([method]) => method !== "Dinheiro" && method !== "Caderneta").reduce((sum, [, value]) => sum + Number(value || 0), 0);
    const expectedAccount = Number(cash.opening_account_amount || 0) + accountReceipts;
    const countedAccount = amount(input.counted_account == null ? expectedAccount : input.counted_account, "o saldo conferido na conta");
    cash.status = "closed"; cash.closed_at = now(); cash.closed_by = input.closed_by.trim(); cash.closing_note = (input.note || "").trim(); cash.sales_count = new Set(parsed.map((sale) => sale.order_id || sale.created_at)).size; cash.account_payments_count = receipts.length;
    const directSalesTotal = directSales.reduce((sum, sale) => sum + Number(sale.quantity || 0) * Number(sale.price || 0), 0);
    const accountChargesTotal = accountSales.reduce((sum, sale) => sum + Number(sale.quantity || 0) * Number(sale.price || 0), 0);
    const accountReceiptsTotal = receipts.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    cash.quantity = parsed.reduce((sum, sale) => sum + Number(sale.quantity || 0), 0);
    cash.total = directSalesTotal + accountReceiptsTotal; cash.direct_sales_total = directSalesTotal; cash.account_charges_total = accountChargesTotal; cash.account_receipts_total = accountReceiptsTotal; cash.gross_sales_total = directSalesTotal + accountChargesTotal;
    cash.payment_totals = paymentTotals; cash.supplies_total = supplies; cash.withdrawals_total = withdrawals; cash.expected_cash = expectedCash; cash.counted_cash = countedCash; cash.difference = countedCash - expectedCash; cash.account_receipts_total = accountReceipts; cash.expected_account = expectedAccount; cash.counted_account = countedAccount; cash.account_difference = countedAccount - expectedAccount;
    const grouped = new Map();
    for (const sale of parsed) {
      const key = sale.description.trim().toLocaleLowerCase();
      const current = grouped.get(key) || { description: sale.description.trim(), quantity: 0, total: 0 };
      current.quantity += Number(sale.quantity || 0);
      current.total += Number(sale.quantity || 0) * Number(sale.price || 0);
      grouped.set(key, current);
    }
    cash.items = [...grouped.values()].sort((a, b) => a.description.localeCompare(b.description));
    const accessRows = await db.prepare("SELECT id,data FROM records WHERE kind='staff_access' AND json_extract(data,'$.cash_session_id')=? AND json_extract(data,'$.revoked_at') IS NULL").bind(id).all();
    const eventRows = await db.prepare("SELECT id,data FROM records WHERE kind='hosted_events' AND json_extract(data,'$.cash_session_id')=? AND COALESCE(json_extract(data,'$.status'),'open')='open'").bind(id).all();
    const statements = [putRecord(db, "cash", id, cash)];
    for (const row of accessRows.results) {
      const access = JSON.parse(row.data);
      access.revoked_at = now();
      access.revoked_reason = "cash_closed";
      statements.push(putRecord(db, "staff_access", row.id, access));
    }
    for (const row of eventRows.results) {
      const hostedEvent = JSON.parse(row.data);
      hostedEvent.status = "closed"; hostedEvent.closed_at = cash.closed_at; hostedEvent.closed_by = cash.closed_by; hostedEvent.closed_reason = "cash_closed";
      statements.push(putRecord(db, "hosted_events", row.id, hostedEvent));
    }
    await db.batch(statements);
  } else throw new Error("Ação desconhecida.");
  return reply({ ok: true, id });
}

function parseBrazilianNumber(value) {
  const normalized = String(value || "").trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function stockProductName(value) {
  const packagingOnly = /^(?:caixa|cx)\s*(?:com|c\/?)?\s*\d+\s*(?:gal(?:ões|oes|ão|ao)|gl)\b|^\d+\s*(?:gal(?:ões|oes|ão|ao)|gl)\s*(?:por|\/|x)\s*(?:caixa|cx)\b|^(?:peso(?:\s+de\s+cada|\s+unitário)?|cada)\s*:?[\s\d.,]*(?:kg|g)\b/i;
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !packagingOnly.test(line)).join(" ").replace(/\s*(?:[/|–-]\s*)?(?:caixa|cx)\s*(?:com|c\/?)\b.*$/i, "").replace(/\s+(?:[-–|]\s*)?\d+\s*(?:gal(?:ões|oes|ão|ao)|gl)\s*(?:por|\/|x)\s*(?:caixa|cx)\b.*$/i, "").replace(/\s*[/|–-]\s*$/, "").replace(/\s+/g, " ").trim();
}

function parseStockOrderText(rawText) {
  const lines = String(rawText || "").replace(/\|/g, "\n").split(/\r?\n/).map((line) => line.replace(/[*_`#]/g, "").trim()).filter((line) => line && !/^[-: ]+$/.test(line));
  const fullText = lines.join("\n"), detectedHeader = lines.findIndex((line) => /(?:^|\s)c[oó]d(?:igo)?\.?(?:\s|$)/i.test(line)), productHeader = Math.max(-1, detectedHeader);
  const supplierLine = lines.find((line) => /CNPJ\s*:/i.test(line)) || "";
  const supplier = supplierLine.split(/CNPJ\s*:/i)[0].trim() || "Fornecedor não identificado";
  const cnpj = (fullText.match(/CNPJ\s*:\s*([\d./-]+)/i)?.[1] || "").replace(/\D/g, "");
  const invoiceNumber = fullText.match(/N[º°o.]?\s*ped\s*:\s*(\d{6,})/i)?.[1] || fullText.match(/Pedido\s*:?\s*(\d{6,})/i)?.[1] || "";
  if (!invoiceNumber) throw new Error("Não foi possível identificar o número do pedido no PDF.");
  const unitMap = { UN: "un", UND: "un", UNID: "un", PT: "pacote", PCT: "pacote", CX: "caixa", KG: "kg", G: "g", GL: "galão", LT: "L", L: "L", ML: "ml", GF: "garrafa", GFA: "garrafa", LATA: "lata", FD: "fardo" };
  const productText = lines.slice(productHeader + 1).join("\n"), rowPattern = /\b(\d{4,10})\s+(\d+(?:[.,]\d+)?)\s+([A-Z]{1,6})\s+([\s\S]*?)(\d+[.,]\d{2})\s+(\d+[.,]\d{2})\s+(\d+[.,]\d{2})(?=\s*\d{4,10}\s|\s*valor\s+total)/gi;
  const items = [...productText.matchAll(rowPattern)].map((match) => ({ name: stockProductName(match[4]), sku: match[1], barcode: "", unit: unitMap[match[3].toUpperCase()] || "un", quantity: parseBrazilianNumber(match[2]), unit_cost: parseBrazilianNumber(match[6]) })).filter((item) => item.name && item.quantity > 0 && Number.isFinite(item.unit_cost));
  if (!items.length) throw new Error("Nenhum produto válido foi reconhecido no PDF.");
  return { invoice_key: `pdf:${cnpj || supplier.toLocaleLowerCase().replace(/\W/g, "")}:${invoiceNumber}`, invoice_number: invoiceNumber, supplier, items, source_type: "pdf" };
}

async function extractPdfInvoice(request, env) {
  if (!(await isAdmin(request, env))) return reply({ error: "Acesso administrativo necessário." }, 401);
  if (!env.AI) return reply({ error: "O leitor de PDF não está configurado no Cloudflare." }, 503);
  const form = await request.formData(), file = form.get("file");
  if (!(file instanceof File) || file.type !== "application/pdf") return reply({ error: "Envie um arquivo PDF válido." }, 400);
  if (file.size > 10 * 1024 * 1024) return reply({ error: "O PDF deve ter no máximo 10 MB." }, 400);
  const converted = await env.AI.toMarkdown({ name: file.name || "pedido.pdf", blob: file }, { conversionOptions: { pdf: { metadata: false } } });
  const document = Array.isArray(converted) ? converted[0] : converted;
  if (!document || document.format === "error" || !document.data) throw new Error(document?.error || "Não foi possível extrair o texto do PDF.");
  return reply(parseStockOrderText(document.data));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/state" && request.method === "GET") {
        const staffToken = request.headers.get("x-staff-access") || "";
        const admin = await isAdmin(request, env);
        const device = await authorizedDevice(request, env);
        if (staffToken) await orderOrigin(env.DB, staffToken);
        else if (!admin && !device) return reply({ error: "Faça login para acessar o sistema." }, 401);
        const result = await state(env.DB);
        for (const access of Object.values(result.device_access || {})) {
          delete access.token_hash;
          delete access.claim_code_hash;
        }
        if (!admin) {
          const allowed = device?.role === "kitchen" ? new Set(["kitchen"]) : new Set(["menu", "accounts", "account_payments", "sales", "kitchen", "cash", "stock_items", "recipes", "stock_events", "hosted_events"]);
          for (const kind of KINDS) if (!allowed.has(kind)) result[kind] = {};
        }
        return reply(result);
      }
      if (url.pathname === "/api/login" && request.method === "POST") return await login(request, env);
      if (url.pathname === "/api/device/claim" && request.method === "POST") return await claimDevice(request, env);
      if (url.pathname === "/api/staff/claim" && request.method === "POST") return await claimStaffAccess(request, env);
      if (url.pathname === "/api/invoice/pdf" && request.method === "POST") return await extractPdfInvoice(request, env);
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
