const normalize = value => String(value || "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
const bulkUnits = new Set(["kg", "g", "L", "ml"]);
const unitNames = { un: "unidades", lata: "latas", "latão": "latões", garrafa: "garrafas", pacote: "pacotes", "galão": "galões", kg: "kg", g: "g", L: "litros", ml: "ml" };
const unitSingular = { un: "unidade", lata: "lata", "latão": "latão", garrafa: "garrafa", pacote: "pacote", "galão": "galão", kg: "kg", g: "g", L: "litro", ml: "ml" };

export function stockEntryDefaults(item = {}) {
  return { unit: item.unit || "un", stock_category: item.stock_category || "Bebida", purchase_unit: ["package", "fardo", "caixa", "pacote"].includes(item.purchase_unit) ? "package" : "direct", units_per_package: Number(item.units_per_package || 1), content_per_unit: item.package_size || "", content_unit: item.package_measure || (bulkUnits.has(item.unit) ? item.unit : "L") };
}

export function stockEntryPayload(values, stocks = {}) {
  const selected = values.id ? stocks[values.id] : null;
  if (values.id && !selected) throw new Error("Este produto não está mais disponível. Busque novamente.");
  const name = selected?.name || String(values.name || "").trim();
  if (!name) throw new Error("Informe o nome do produto.");
  if (!selected && Object.values(stocks).some(item => normalize(item.name) === normalize(name))) throw new Error("Este produto já existe. Selecione o resultado da busca para adicionar saldo.");
  const quantity = Number(values.quantity), total = Number(values.total_paid);
  if (values.quantity === "" || !Number.isFinite(quantity) || quantity <= 0) throw new Error("Informe quanto chegou, usando uma quantidade maior que zero.");
  if (values.total_paid === "" || values.total_paid == null || !Number.isFinite(total) || total < 0) throw new Error("Informe o valor total pago. Use zero se não houve custo.");
  const unit = selected?.unit || values.unit || "un", packaged = values.purchase_unit === "package";
  const units = packaged ? Number(values.units_per_package) : 1;
  if (!Number.isSafeInteger(units) || units < 1) throw new Error("Informe quantas unidades vêm em cada embalagem.");
  if (packaged && !Number.isInteger(quantity)) throw new Error("Informe uma quantidade inteira de embalagens.");
  const content = packaged && bulkUnits.has(unit) ? Number(values.content_per_unit) : 1;
  if (!Number.isFinite(content) || content <= 0) throw new Error("Informe o conteúdo de cada unidade da embalagem.");
  const contentUnit = values.content_unit || unit;
  const factors = { "g:kg": .001, "kg:g": 1000, "ml:L": .001, "L:ml": 1000 };
  const factor = !packaged || !bulkUnits.has(unit) || unit === contentUnit ? 1 : factors[`${contentUnit}:${unit}`];
  if (!factor) throw new Error("Escolha uma medida compatível com este produto.");
  const amount = quantity * units * content * factor;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Confira a quantidade e a embalagem.");
  const minimum = Number(values.stock_minimum || 0);
  if (!Number.isFinite(minimum) || minimum < 0) throw new Error("Informe um estoque mínimo válido.");
  return { line: { ...(selected ? { id: values.id } : {}), name, unit, stock_category: selected?.stock_category || values.stock_category || "Bebida", stock_minimum: minimum, purchase_unit: packaged ? "package" : "direct", units_per_package: units, content_per_unit: content, content_unit: contentUnit, package_quantity: quantity, total_paid: total, ...(String(values.supplier || "").trim() ? { supplier: String(values.supplier).trim() } : {}) }, amount, unitCost: total / amount };
}

export function findStockEntryProducts(stocks, query) {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return Object.entries(stocks).filter(([, item]) => terms.every(term => normalize([item.name, item.sku, item.barcode].join(" ")).includes(term))).sort((a, b) => Number(b[1].purchase_count || 0) - Number(a[1].purchase_count || 0) || a[1].name.localeCompare(b[1].name)).slice(0, 6);
}

export function createStockEntry({ getStocks, openModal, closeModal, modalBody, mutate, draw, toast, esc, money, stockQuantity }) {
  let saving = false;
  const valuesOf = form => Object.fromEntries(new FormData(form));
  function open(selectedId = "") {
    if (saving) return;
    const stocks = getStocks(), selected = stocks[selectedId], defaults = stockEntryDefaults(selected);
    const options = (list, current) => list.map(([value, label]) => `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`).join("");
    const shortcuts = findStockEntryProducts(stocks, "");
    openModal(`<div class="stock-entry-heading"><span class="eyebrow">Cadastro e reposição</span><h2>Adicionar estoque</h2><p class="muted">Escolha o produto, informe quanto chegou e o valor total pago.</p></div><form data-form="stock-entry" class="stock-entry-form"><input type="hidden" name="id" value="${esc(selectedId)}"><div class="field"><label for="stock-entry-name">Produto</label><input id="stock-entry-name" name="name" value="${esc(selected?.name || "")}" placeholder="Buscar produto ou digitar um novo nome..." autocomplete="off" required aria-controls="stock-entry-results"><div id="stock-entry-results" class="stock-entry-results" hidden></div><small class="muted" data-entry-selection></small></div>${shortcuts.length ? `<div class="stock-entry-shortcuts"><span>Mais usados</span><div>${shortcuts.map(([id, item]) => `<button type="button" data-entry-product="${esc(id)}">${esc(item.name)}</button>`).join("")}</div></div>` : ""}<div class="form-row" data-entry-new><div class="field"><label for="stock-entry-unit">Como contar este produto?</label><select id="stock-entry-unit" name="unit">${options([["un", "Unidades"], ["kg", "Quilos (kg)"], ["L", "Litros (L)"]], defaults.unit)}</select></div><div class="field"><label for="stock-entry-category">Categoria</label><select id="stock-entry-category" name="stock_category">${options([["Bebida", "Bebida"], ["Comida", "Comida / ingrediente"], ["Descartável", "Embalagem / descartável"]], defaults.stock_category)}</select></div></div><div class="stock-entry-quantity"><div class="field"><label for="stock-entry-quantity" data-entry-quantity-label>Quanto chegou?</label><input id="stock-entry-quantity" name="quantity" type="number" min=".001" step=".001" inputmode="decimal" placeholder="Ex.: 3" required></div><div class="field"><label for="stock-entry-measure">Medida da entrada</label><select id="stock-entry-measure" name="purchase_unit">${options([["direct", unitNames[defaults.unit] || defaults.unit], ["package", "Embalagens"]], defaults.purchase_unit)}</select></div></div><details class="stock-entry-packaging" data-entry-packaging><summary data-entry-package-label>Configurar embalagem</summary><p class="muted">O sistema lembrará esta embalagem na próxima entrada.</p><div class="field"><label for="stock-entry-units">Unidades por embalagem</label><input id="stock-entry-units" name="units_per_package" type="number" min="1" step="1" inputmode="numeric" value="${defaults.units_per_package}"></div><div class="form-row" data-entry-content><div class="field"><label for="stock-entry-content">Conteúdo de cada unidade</label><input id="stock-entry-content" name="content_per_unit" type="number" min=".001" step=".001" inputmode="decimal" value="${defaults.content_per_unit}"></div><div class="field"><label for="stock-entry-content-unit">Medida do conteúdo</label><select id="stock-entry-content-unit" name="content_unit">${options([["kg", "kg"], ["g", "g"], ["L", "L"], ["ml", "ml"]], defaults.content_unit)}</select></div></div></details><div class="field"><label for="stock-entry-paid">Valor total pago</label><input id="stock-entry-paid" name="total_paid" type="number" min="0" step=".01" inputmode="decimal" placeholder="R$ 0,00" required><small class="muted">Informe o valor de todos os itens desta entrada. O custo de cada unidade é calculado automaticamente.</small></div><div class="stock-entry-preview" data-entry-preview role="status" aria-live="polite"></div><details class="stock-entry-optional"><summary>Mais informações (opcional)</summary><div class="field"><label for="stock-entry-supplier">Fornecedor</label><input id="stock-entry-supplier" name="supplier" value="${esc(selected?.supplier || "")}"></div><div class="field"><label for="stock-entry-note">Observação</label><input id="stock-entry-note" name="note" placeholder="Ex.: compra para o fim de semana"></div><div class="field" data-entry-minimum><label for="stock-entry-minimum">Estoque mínimo</label><input id="stock-entry-minimum" name="stock_minimum" type="number" min="0" step=".001" inputmode="decimal" value="0"></div></details><div class="stock-entry-actions"><button type="submit" class="primary" name="next" value="finish">Salvar no estoque</button><button type="submit" name="next" value="another">Salvar e adicionar outro</button></div><p class="stock-entry-feedback" data-entry-error role="alert" hidden></p></form>`);
    const form = modalBody.querySelector("[data-form='stock-entry']");
    form.querySelector("[data-entry-packaging]").open = Boolean(defaults.purchase_unit === "package" && (!selected || (bulkUnits.has(defaults.unit) && !defaults.content_per_unit)));
    form.addEventListener("invalid", event => { const details = event.target.closest("details"); if (details) details.open = true; }, true);
    form.addEventListener("input", event => {
      if (event.target.name === "name") { form.elements.id.value = ""; search(form); }
      update(form);
    });
    form.addEventListener("change", event => {
      if (event.target.name === "unit" && !form.elements.id.value) {
        if (event.target.value === "kg") form.elements.stock_category.value = "Comida";
        if (bulkUnits.has(event.target.value)) form.elements.content_unit.value = event.target.value;
      }
      if (event.target.name === "purchase_unit" && event.target.value === "package") form.querySelector("[data-entry-packaging]").open = !form.elements.id.value || (bulkUnits.has(currentUnit(form)) && !form.elements.content_per_unit.value);
      update(form);
    });
    form.addEventListener("click", event => {
      const button = event.target.closest("[data-entry-product]");
      if (button) select(form, button.dataset.entryProduct);
    });
    form.addEventListener("submit", async event => {
      event.preventDefault(); event.stopPropagation();
      if (saving) return;
      const another = event.submitter?.value === "another";
      const errorBox = form.querySelector("[data-entry-error]");
      errorBox.hidden = true;
      let payload;
      try { payload = stockEntryPayload(valuesOf(form), getStocks()); }
      catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; return; }
      const note = form.elements.note.value.trim();
      saving = true; form.inert = true;
      try {
        await mutate({ action: "stock.purchase.batch", note, items: [payload.line] }, true);
        draw();
        saving = false;
        if (another) open(); else closeModal();
        toast(`${payload.line.name}: ${stockQuantity(payload.amount)} ${unitNames[payload.line.unit] || payload.line.unit} adicionados ao estoque.`);
      } catch (error) {
        if (form.isConnected) { errorBox.textContent = error.message; errorBox.hidden = false; }
        else toast(error.message, true);
      } finally { saving = false; if (form.isConnected) form.inert = false; }
    });
    update(form);
    (selected ? form.elements.quantity : form.elements.name).focus();
  }
  const currentUnit = form => getStocks()[form.elements.id.value]?.unit || form.elements.unit.value || "un";
  function search(form) {
    const term = form.elements.name.value.trim(), results = form.querySelector(".stock-entry-results");
    const matches = term ? findStockEntryProducts(getStocks(), term) : [];
    results.hidden = !matches.length;
    results.innerHTML = matches.map(([id, item]) => `<button type="button" data-entry-product="${esc(id)}"><b>${esc(item.name)}</b><small>Em estoque: ${stockQuantity(item.stock_quantity || 0)} ${esc(unitNames[item.unit] || item.unit || "unidades")}</small></button>`).join("");
  }
  function select(form, id) {
    const item = getStocks()[id]; if (!item) return;
    const defaults = stockEntryDefaults(item);
    form.elements.id.value = id; form.elements.name.value = item.name;
    for (const name of ["purchase_unit", "units_per_package", "content_per_unit", "content_unit"]) form.elements[name].value = defaults[name];
    form.elements.supplier.value = item.supplier || "";
    form.querySelector(".stock-entry-results").hidden = true;
    form.querySelector("[data-entry-packaging]").open = defaults.purchase_unit === "package" && bulkUnits.has(defaults.unit) && !defaults.content_per_unit;
    update(form); form.elements.quantity.focus();
  }
  function update(form) {
    const item = getStocks()[form.elements.id.value], unit = currentUnit(form), packaged = form.elements.purchase_unit.value === "package", bulk = packaged && bulkUnits.has(unit);
    const newFields = form.querySelector("[data-entry-new]"); newFields.hidden = Boolean(item);
    for (const input of newFields.querySelectorAll("select")) input.disabled = Boolean(item);
    form.querySelector("[data-entry-selection]").textContent = item ? `Repor produto cadastrado · saldo atual: ${stockQuantity(item.stock_quantity || 0)} ${unitNames[unit] || unit}` : form.elements.name.value.trim() ? "Novo produto: será cadastrado ao salvar." : "Busque um produto cadastrado ou digite o nome de um novo.";
    form.elements.purchase_unit.options[0].textContent = unitNames[unit] || unit;
    form.elements.quantity.step = packaged ? "1" : ".001";
    form.elements.quantity.min = packaged ? "1" : ".001";
    form.querySelector("[data-entry-quantity-label]").textContent = packaged ? "Quantas embalagens chegaram?" : `Quanto chegou em ${unitNames[unit] || unit}?`;
    const packaging = form.querySelector("[data-entry-packaging]"); packaging.hidden = !packaged;
    form.elements.units_per_package.disabled = !packaged; form.elements.units_per_package.required = packaged;
    form.querySelector("[data-entry-content]").hidden = !bulk;
    for (const name of ["content_per_unit", "content_unit"]) { form.elements[name].disabled = !bulk; form.elements[name].required = bulk; }
    for (const option of form.elements.content_unit.options) option.disabled = bulk && (["kg", "g"].includes(unit) ? !["kg", "g"].includes(option.value) : !["L", "ml"].includes(option.value));
    const content = bulk && form.elements.content_per_unit.value ? ` de ${form.elements.content_per_unit.value} ${form.elements.content_unit.value}` : "";
    form.querySelector("[data-entry-package-label]").textContent = `Embalagem com ${form.elements.units_per_package.value || "?"} unidade(s)${content} · alterar`;
    form.querySelector("[data-entry-minimum]").hidden = Boolean(item); form.elements.stock_minimum.disabled = Boolean(item);
    const preview = form.querySelector("[data-entry-preview]");
    try {
      const payload = stockEntryPayload(valuesOf(form), getStocks());
      preview.innerHTML = `<span>Resumo da entrada</span><b>Adicionar ${stockQuantity(payload.amount)} ${esc(unitNames[unit] || unit)}</b><div><span>Total pago <strong>${money(payload.line.total_paid)}</strong></span><span>Custo por ${esc(unitSingular[unit] || unit)} <strong>${money(payload.unitCost)}</strong></span></div>`;
    } catch (error) { preview.textContent = form.elements.quantity.value && form.elements.total_paid.value !== "" ? error.message : "Preencha a quantidade e o valor total para conferir a entrada."; }
  }
  return { open };
}
