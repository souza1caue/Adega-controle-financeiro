from __future__ import annotations

import base64
import json
from datetime import date, datetime, timedelta
from html import escape
from pathlib import Path
from uuid import uuid4

import streamlit as st


DATA_DIR = Path("data")
FIADO_FILE = DATA_DIR / "fiado.json"
MENU_FILE = DATA_DIR / "cardapio.json"
SALES_FILE = DATA_DIR / "saidas.json"
KITCHEN_FILE = DATA_DIR / "cozinha.json"
CASH_SESSIONS_FILE = DATA_DIR / "caixas.json"
LOGO_FILE = Path("assets") / "emblema-adega-camisa10.png"
MENU_CATEGORIES = ["Bebidas", "Comidas"]
ADMIN_PASSWORD = "admin"


st.set_page_config(page_title="Controle da Adega", page_icon=":wine_glass:", layout="wide")


def load_json(path: Path, empty_message: str) -> dict:
    DATA_DIR.mkdir(exist_ok=True)

    if not path.exists():
        path.write_text("{}", encoding="utf-8")
        return {}

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        st.error(empty_message)
        return {}


def save_json(path: Path, data: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_accounts() -> dict:
    return load_json(FIADO_FILE, "Nao foi possivel ler o arquivo da caderneta.")


def load_menu() -> dict:
    return load_json(MENU_FILE, "Nao foi possivel ler o arquivo do cardapio.")


def load_sales() -> dict:
    return load_json(SALES_FILE, "Nao foi possivel ler o arquivo de saidas.")


def load_kitchen_orders() -> dict:
    return load_json(KITCHEN_FILE, "Nao foi possivel ler o arquivo da cozinha.")


def load_cash_sessions() -> dict:
    return load_json(CASH_SESSIONS_FILE, "Nao foi possivel ler o arquivo de caixas.")


def save_accounts(accounts: dict) -> None:
    save_json(FIADO_FILE, accounts)


def save_menu(menu: dict) -> None:
    save_json(MENU_FILE, menu)


def save_sales(sales: dict) -> None:
    save_json(SALES_FILE, sales)


def save_kitchen_orders(kitchen_orders: dict) -> None:
    save_json(KITCHEN_FILE, kitchen_orders)


def save_cash_sessions(cash_sessions: dict) -> None:
    save_json(CASH_SESSIONS_FILE, cash_sessions)


def money(value: float) -> str:
    return f"R$ {value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def logo_markup() -> str:
    if not LOGO_FILE.exists():
        return '<div class="brand-logo-slot brand-logo-fallback">10</div>'

    encoded_logo = base64.b64encode(LOGO_FILE.read_bytes()).decode("ascii")
    return (
        '<div class="brand-logo-slot">'
        f'<img src="data:image/png;base64,{encoded_logo}" alt="Adega Camisa 10">'
        "</div>"
    )


def brand_header_markup() -> str:
    return (
        '<header class="brand-hero">'
        f"{logo_markup()}"
        '<div class="brand-copy">'
        '<span class="brand-kicker">estoque, fiado e controle da casa</span>'
        '<span class="brand-title">Controle Adega Camisa 10</span>'
        "</div>"
        "</header>"
    )


def now_label() -> str:
    return datetime.now().strftime("%d/%m/%Y %H:%M")


def display_datetime(value: str | None) -> str:
    if not value:
        return "Sem data"

    try:
        return datetime.fromisoformat(value).strftime("%d/%m/%Y %H:%M")
    except ValueError:
        try:
            return datetime.fromisoformat(f"{value}T00:00").strftime("%d/%m/%Y %H:%M")
        except ValueError:
            return value


def account_total(account: dict) -> float:
    return sum(float(item.get("quantity", 0)) * float(item.get("price", 0)) for item in account.get("items", []))


def grouped_account_items(items: list[dict]) -> list[dict]:
    groups: dict[str, dict] = {}

    for index, item in enumerate(items):
        description = item.get("description", "").strip()
        group_key = description.lower()
        quantity = float(item.get("quantity", 0))
        price = float(item.get("price", 0))
        total = quantity * price

        groups.setdefault(
            group_key,
            {
                "description": description,
                "quantity": 0.0,
                "total": 0.0,
                "entries": [],
            },
        )
        groups[group_key]["quantity"] += quantity
        groups[group_key]["total"] += total
        groups[group_key]["entries"].append({"index": index, "item": item, "total": total})

    return sorted(groups.values(), key=lambda group: group["description"].lower())


def sale_total(sale: dict) -> float:
    return float(sale.get("quantity", 0)) * float(sale.get("price", 0))


def grouped_sales(sales: dict) -> list[dict]:
    groups: dict[str, dict] = {}

    for sale_id, sale in sales.items():
        description = sale.get("description", "").strip()
        group_key = description.lower()
        quantity = float(sale.get("quantity", 0))
        total = sale_total(sale)

        groups.setdefault(
            group_key,
            {
                "description": description,
                "quantity": 0.0,
                "total": 0.0,
                "entries": [],
            },
        )
        groups[group_key]["quantity"] += quantity
        groups[group_key]["total"] += total
        groups[group_key]["entries"].append({"sale_id": sale_id, "sale": sale, "total": total})

    return sorted(groups.values(), key=lambda group: group["description"].lower())


def sale_created_date(sale: dict) -> date | None:
    created_at = str(sale.get("created_at", ""))
    if not created_at:
        return None

    try:
        return date.fromisoformat(created_at[:10])
    except ValueError:
        return None


def sales_for_period(sales: dict, period: str) -> dict:
    today = date.today()

    if period == "Semanal":
        start_date = today - timedelta(days=today.weekday())
    elif period == "Mensal":
        start_date = today.replace(day=1)
    else:
        start_date = today

    return {
        sale_id: sale
        for sale_id, sale in sales.items()
        if (sale_date := sale_created_date(sale)) is not None and start_date <= sale_date <= today
    }


def active_cash_session(cash_sessions: dict) -> tuple[str, dict] | tuple[None, None]:
    open_sessions = [
        (session_id, session)
        for session_id, session in cash_sessions.items()
        if session.get("status") == "open"
    ]
    if not open_sessions:
        return None, None

    open_sessions.sort(key=lambda session_item: session_item[1].get("opened_at", ""), reverse=True)
    return open_sessions[0]


def open_cash_session(cash_sessions: dict) -> str:
    active_session_id, _active_session = active_cash_session(cash_sessions)
    if active_session_id is not None:
        return active_session_id

    session_id = str(uuid4())
    cash_sessions[session_id] = {
        "status": "open",
        "opened_at": datetime.now().isoformat(timespec="minutes"),
        "closed_at": "",
    }
    save_cash_sessions(cash_sessions)
    return session_id


def sales_for_cash_session(sales: dict, cash_session_id: str) -> dict:
    return {
        sale_id: sale
        for sale_id, sale in sales.items()
        if sale.get("cash_session_id") == cash_session_id
    }


def close_cash_session(cash_sessions: dict, sales: dict, cash_session_id: str) -> None:
    if cash_session_id not in cash_sessions:
        return

    session_sales = sales_for_cash_session(sales, cash_session_id)
    cash_sessions[cash_session_id]["status"] = "closed"
    cash_sessions[cash_session_id]["closed_at"] = datetime.now().isoformat(timespec="minutes")
    cash_sessions[cash_session_id]["sales_count"] = len(session_sales)
    cash_sessions[cash_session_id]["total"] = sum(sale_total(sale) for sale in session_sales.values())
    cash_sessions[cash_session_id]["quantity"] = sum(float(sale.get("quantity", 0)) for sale in session_sales.values())
    cash_sessions[cash_session_id]["items"] = [
        {
            "description": group["description"],
            "quantity": group["quantity"],
            "total": group["total"],
        }
        for group in grouped_sales(session_sales)
    ]
    save_cash_sessions(cash_sessions)


def cash_session_label(session_id: str, session: dict) -> str:
    opened_at = display_datetime(session.get("opened_at"))
    closed_at = display_datetime(session.get("closed_at")) if session.get("closed_at") else "aberto"
    status = "Aberto" if session.get("status") == "open" else "Fechado"
    return f"{status} | {opened_at} ate {closed_at}"


def menu_item_category(item: dict) -> str:
    category = item.get("category")
    if category in MENU_CATEGORIES:
        return category

    name = item.get("name", "").lower()
    food_words = ["porcao", "batata", "carne", "frango", "lanche", "comida"]
    if any(word in name for word in food_words):
        return "Comidas"

    return "Bebidas"


def menu_items_by_category(menu: dict, category: str) -> list[tuple[str, dict]]:
    return sorted(
        ((item_id, item) for item_id, item in menu.items() if menu_item_category(item) == category),
        key=lambda menu_item: menu_item[1]["name"].lower(),
    )


def create_account(accounts: dict, customer_name: str, note: str) -> str:
    account_id = str(uuid4())
    accounts[account_id] = {
        "customer_name": customer_name.strip(),
        "note": note.strip(),
        "created_at": date.today().isoformat(),
        "items": [],
    }
    save_accounts(accounts)
    return account_id


def add_item(accounts: dict, account_id: str, description: str, quantity: float, price: float) -> None:
    accounts[account_id]["items"].append(
        {
            "description": description.strip(),
            "quantity": quantity,
            "price": price,
            "created_at": datetime.now().isoformat(timespec="minutes"),
        }
    )
    save_accounts(accounts)


def delete_item(accounts: dict, account_id: str, item_index: int) -> None:
    accounts[account_id]["items"].pop(item_index)
    save_accounts(accounts)


def add_menu_item(menu: dict, name: str, price: float, category: str) -> None:
    menu[str(uuid4())] = {
        "name": name.strip(),
        "price": price,
        "category": category,
        "created_at": datetime.now().isoformat(timespec="minutes"),
    }
    save_menu(menu)


def update_menu_item(menu: dict, item_id: str, name: str, price: float, category: str) -> None:
    menu[item_id]["name"] = name.strip()
    menu[item_id]["price"] = price
    menu[item_id]["category"] = category
    menu[item_id]["updated_at"] = datetime.now().isoformat(timespec="minutes")
    save_menu(menu)


def delete_menu_item(menu: dict, item_id: str) -> None:
    menu.pop(item_id, None)
    save_menu(menu)


def add_sale(
    sales: dict,
    description: str,
    quantity: float,
    price: float,
    payment_method: str,
    note: str,
    customer_name: str = "",
    cash_session_id: str = "",
) -> str:
    sale_id = str(uuid4())
    sales[sale_id] = {
        "description": description.strip(),
        "quantity": quantity,
        "price": price,
        "payment_method": payment_method,
        "note": note.strip(),
        "customer_name": customer_name.strip(),
        "cash_session_id": cash_session_id,
        "created_at": datetime.now().isoformat(timespec="minutes"),
    }
    save_sales(sales)
    return sale_id


def delete_sale(sales: dict, sale_id: str) -> None:
    sales.pop(sale_id, None)
    save_sales(sales)


def add_kitchen_order(
    kitchen_orders: dict,
    description: str,
    quantity: float,
    customer_name: str,
    note: str,
    origin: str,
    price: float = 0.0,
    payment_method: str = "",
) -> None:
    kitchen_orders[str(uuid4())] = {
        "description": description.strip(),
        "quantity": quantity,
        "price": price,
        "payment_method": payment_method,
        "customer_name": customer_name.strip(),
        "note": note.strip(),
        "origin": origin,
        "status": "pending",
        "created_at": datetime.now().isoformat(timespec="minutes"),
    }
    save_kitchen_orders(kitchen_orders)


def complete_kitchen_order(kitchen_orders: dict, order_id: str) -> None:
    if order_id not in kitchen_orders:
        return

    kitchen_orders[order_id]["status"] = "done"
    kitchen_orders[order_id]["completed_at"] = datetime.now().isoformat(timespec="minutes")
    save_kitchen_orders(kitchen_orders)


def start_kitchen_order(kitchen_orders: dict, order_id: str) -> None:
    if order_id not in kitchen_orders:
        return

    kitchen_orders[order_id]["status"] = "started"
    kitchen_orders[order_id]["started_at"] = datetime.now().isoformat(timespec="minutes")
    save_kitchen_orders(kitchen_orders)


def kitchen_status_label(status: str) -> str:
    labels = {
        "pending": "Pendente",
        "started": "Iniciada",
        "done": "Concluida",
    }
    return labels.get(status, status or "Pendente")


def render_sale_details(sale: dict) -> None:
    if sale.get("customer_name"):
        st.caption(f'Cliente: {sale["customer_name"]}')

    if sale.get("note"):
        st.caption(sale["note"])


def close_account_dialog() -> None:
    st.session_state.open_account_id = None


def close_new_account_dialog() -> None:
    st.session_state.show_new_account_dialog = False


def close_menu_item_dialog() -> None:
    st.session_state.edit_menu_item_id = None


@st.dialog("Nova nota", width="small", on_dismiss=close_new_account_dialog)
def show_new_account_dialog(accounts: dict) -> None:
    with st.form("new_account_dialog_form", clear_on_submit=True):
        customer_name = st.text_input("Cliente")
        note = st.text_area("Observacao da nota", placeholder="Ex.: paga no sabado, retirar casco...")
        submitted = st.form_submit_button("Adicionar nota")

    if submitted:
        if not customer_name.strip():
            st.warning("Informe o nome do cliente.")
        else:
            st.session_state.open_account_id = create_account(accounts, customer_name, note)
            st.session_state.show_new_account_dialog = False
            st.success("Nota criada.")
            st.rerun()


@st.dialog("Conta aberta", width="large", on_dismiss=close_account_dialog)
def show_account_dialog(accounts: dict, account_id: str, menu: dict) -> None:
    account = accounts[account_id]

    st.markdown(f"### {account['customer_name']}")
    st.caption(f"Aberta em {account['created_at']}")

    if account.get("note"):
        st.write(account["note"])

    st.metric("Total em aberto", money(account_total(account)))
    st.markdown("#### Itens anotados")

    items = account.get("items", [])
    if not items:
        st.info("Nenhum item anotado nesta conta.")
    else:
        for group in grouped_account_items(items):
            label = f'{group["description"]} | {group["quantity"]:g} un. | {money(group["total"])}'
            with st.expander(label):
                st.caption("Registros individuais deste item")
                for entry in group["entries"]:
                    index = entry["index"]
                    item = entry["item"]
                    cols = st.columns([1.4, 1, 1, 1])
                    cols[0].write(display_datetime(item.get("created_at")))
                    cols[1].write(f'{float(item["quantity"]):g} un.')
                    cols[2].write(money(entry["total"]))
                    if cols[3].button("Remover", key=f"delete_{account_id}_{index}"):
                        delete_item(accounts, account_id, index)
                        st.rerun()

    st.markdown("#### Adicionar item")

    if menu:
        menu_options = sorted(menu.items(), key=lambda menu_item: menu_item[1]["name"].lower())
        with st.form(f"menu_item_form_{account_id}", clear_on_submit=True):
            selected_menu_id = st.selectbox(
                "Item do cardapio",
                options=[item_id for item_id, _ in menu_options],
                format_func=lambda item_id: f'{menu[item_id]["name"]} - {money(float(menu[item_id]["price"]))}',
            )
            quantity = st.number_input("Quantidade", min_value=0.01, value=1.0, step=1.0)
            add_from_menu = st.form_submit_button("Adicionar do cardapio")

        if add_from_menu:
            selected_item = menu[selected_menu_id]
            add_item(accounts, account_id, selected_item["name"], quantity, float(selected_item["price"]))
            st.success(f"Item adicionado as {now_label()}.")
            st.rerun()
    else:
        st.info("Cadastre itens na aba Cardapio para adicionar sem digitar nome e valor.")

    with st.expander("Adicionar item manualmente"):
        with st.form(f"manual_item_form_{account_id}", clear_on_submit=True):
            description = st.text_input("Item", placeholder="Ex.: vinho, cerveja, gelo...")
            quantity = st.number_input("Quantidade", min_value=0.01, value=1.0, step=1.0)
            price = st.number_input("Valor unitario", min_value=0.0, value=0.0, step=1.0)
            add_submitted = st.form_submit_button("Adicionar item manual")

        if add_submitted:
            if not description.strip():
                st.warning("Informe o item.")
            else:
                add_item(accounts, account_id, description, quantity, price)
                st.success(f"Item adicionado as {now_label()}.")
                st.rerun()


def render_accounts_tab(accounts: dict, menu: dict) -> None:
    st.markdown('<h2 class="section-title">Caderneta do fiado</h2>', unsafe_allow_html=True)

    title_col, action_col = st.columns([1, 0.18])
    title_col.markdown('<h2 class="section-title">Contas abertas</h2>', unsafe_allow_html=True)
    with action_col:
        st.markdown('<span id="new-account-action"></span>', unsafe_allow_html=True)
        if st.button("+", key="open_new_account_dialog", help="Adicionar nova nota"):
            st.session_state.show_new_account_dialog = True
            st.rerun()

    if not accounts:
        st.info("Nenhuma conta aberta ainda. Clique no + para criar a primeira nota.")
    else:
        account_items = list(accounts.items())
        for row_start in range(0, len(account_items), 4):
            cols = st.columns(4)
            for col, (account_id, account) in zip(cols, account_items[row_start : row_start + 4]):
                total = account_total(account)
                item_count = len(account.get("items", []))
                with col:
                    customer_name = escape(account["customer_name"])
                    note = escape(account.get("note") or "Sem observacao")
                    st.markdown(
                        f"""
                        <div class="account-card">
                            <h3>{customer_name}</h3>
                            <p class="muted">{item_count} item(ns)</p>
                            <p>{note}</p>
                            <p class="total">{money(total)}</p>
                        </div>
                        """,
                        unsafe_allow_html=True,
                    )
                    if st.button("Abrir conta", key=f"select_{account_id}"):
                        st.session_state.open_account_id = account_id
                        st.rerun()

    open_account_id = st.session_state.open_account_id
    if open_account_id in accounts:
        show_account_dialog(accounts, open_account_id, menu)
    elif open_account_id is not None:
        st.session_state.open_account_id = None

    if st.session_state.show_new_account_dialog:
        show_new_account_dialog(accounts)


@st.dialog("Editar item", width="small", on_dismiss=close_menu_item_dialog)
def show_menu_item_dialog(menu: dict, item_id: str) -> None:
    item = menu.get(item_id)
    if item is None:
        st.warning("Item nao encontrado.")
        st.session_state.edit_menu_item_id = None
        return

    with st.form(f"edit_menu_item_{item_id}"):
        edited_name = st.text_input("Item", value=item["name"], key=f"name_{item_id}")
        edit_cols = st.columns([1, 1])
        edited_price = edit_cols[0].number_input(
            "Valor",
            min_value=0.0,
            value=float(item["price"]),
            step=1.0,
            key=f"price_{item_id}",
        )
        edited_category = edit_cols[1].selectbox(
            "Categoria",
            MENU_CATEGORIES,
            index=MENU_CATEGORIES.index(menu_item_category(item)),
            key=f"category_{item_id}",
        )
        button_cols = st.columns([1, 1])
        with button_cols[0]:
            save_submitted = st.form_submit_button("Salvar")
        with button_cols[1]:
            cancel_submitted = st.form_submit_button("Cancelar")

    delete_submitted = st.button("Remover item", key=f"delete_menu_item_{item_id}", use_container_width=True)

    if save_submitted:
        if not edited_name.strip():
            st.warning("Informe o nome do item.")
        else:
            update_menu_item(menu, item_id, edited_name, edited_price, edited_category)
            st.session_state.edit_menu_item_id = None
            st.success("Item atualizado.")
            st.rerun()

    if cancel_submitted:
        st.session_state.edit_menu_item_id = None
        st.rerun()

    if delete_submitted:
        delete_menu_item(menu, item_id)
        st.session_state.edit_menu_item_id = None
        st.success("Item removido.")
        st.rerun()


def render_menu_item_row(menu: dict, item_id: str, item: dict) -> None:

    with st.container(border=True):
        st.markdown('<span class="menu-item-row-marker"></span>', unsafe_allow_html=True)
        item_cols = st.columns([3, 1.2, 0.8])
        item_cols[0].write(item["name"])
        item_cols[1].write(money(float(item["price"])))
        item_cols[2].markdown('<span class="menu-edit-action"></span>', unsafe_allow_html=True)
        if item_cols[2].button("Editar", key=f"open_edit_menu_item_{item_id}", help="Editar item", use_container_width=True):
            st.session_state.edit_menu_item_id = item_id
            st.rerun()


def render_menu_tab(menu: dict) -> None:
    st.markdown('<h2 class="section-title">Cardapio</h2>', unsafe_allow_html=True)

    with st.form("new_menu_item_form", clear_on_submit=True):
        cols = st.columns([3, 1, 1.2, 1])
        name = cols[0].text_input("Item")
        price = cols[1].number_input("Valor", min_value=0.0, value=0.0, step=1.0)
        category = cols[2].selectbox("Categoria", MENU_CATEGORIES)
        with cols[3]:
            submitted = st.form_submit_button("Cadastrar")

    if submitted:
        if not name.strip():
            st.warning("Informe o nome do item.")
        else:
            add_menu_item(menu, name, price, category)
            st.success("Item cadastrado no cardapio.")
            st.rerun()

    st.markdown('<h2 class="section-title">Itens cadastrados</h2>', unsafe_allow_html=True)

    if not menu:
        st.info("Nenhum item cadastrado ainda.")
        return

    category_cols = st.columns(2)
    for col, category_name in zip(category_cols, MENU_CATEGORIES):
        with col:
            st.markdown(f"### {category_name}")
            category_items = menu_items_by_category(menu, category_name)
            if not category_items:
                st.info(f"Nenhum item em {category_name.lower()}.")
                continue
            for item_id, item in category_items:
                render_menu_item_row(menu, item_id, item)

    edit_menu_item_id = st.session_state.edit_menu_item_id
    if edit_menu_item_id in menu:
        show_menu_item_dialog(menu, edit_menu_item_id)
    elif edit_menu_item_id is not None:
        st.session_state.edit_menu_item_id = None


def close_quick_sale_dialog() -> None:
    st.session_state.quick_sale_item_id = None


def select_payment_option(state_key: str, selected_key: str, selected_option: str, option_keys: list[str]) -> None:
    if not st.session_state.get(selected_key):
        if st.session_state.get(state_key) == selected_option:
            st.session_state[state_key] = ""
        return

    st.session_state[state_key] = selected_option
    for option_key in option_keys:
        if option_key != selected_key:
            st.session_state[option_key] = False


def payment_checkbox_group(label: str, options: list[str], state_key: str) -> str:
    if state_key not in st.session_state:
        st.session_state[state_key] = options[0]
    elif st.session_state[state_key] not in options:
        st.session_state[state_key] = options[0]

    st.markdown(f"**{label}**")
    option_keys = [f"{state_key}_{index}" for index, _ in enumerate(options)]
    cols = st.columns(len(options))

    for col, option, option_key in zip(cols, options, option_keys):
        st.session_state[option_key] = st.session_state[state_key] == option

        with col:
            st.checkbox(
                option,
                key=option_key,
                on_change=select_payment_option,
                args=(state_key, option_key, option, option_keys),
            )

    return st.session_state.get(state_key, "")


@st.dialog("Adicionar item", width="small", on_dismiss=close_quick_sale_dialog)
def show_quick_sale_dialog(
    accounts: dict,
    sales: dict,
    kitchen_orders: dict,
    menu: dict,
    item_id: str,
    payment_options: list[str],
    cash_session_id: str | None,
) -> None:
    item = menu[item_id]
    item_name = item["name"]
    item_price = float(item["price"])

    st.markdown(f"### {item_name}")
    st.caption(f"Valor unitario: {money(item_price)}")

    quantity = st.number_input("Quantidade", min_value=0.01, value=1.0, step=1.0, key=f"quick_dialog_qty_{item_id}")
    payment_method = payment_checkbox_group("Metodo de pagamento", payment_options, f"quick_dialog_payment_{item_id}")
    send_to_account = st.checkbox("Enviar para caderneta", key=f"quick_dialog_to_account_{item_id}")

    selected_account_id = None
    new_customer_name = ""
    account_note = ""
    note = ""
    order_customer_name = ""
    is_food_item = menu_item_category(item) == "Comidas"

    if is_food_item:
        order_customer_name = st.text_input("Cliente do pedido", key=f"quick_dialog_order_customer_{item_id}")

    if send_to_account:
        account_options = sorted(accounts.items(), key=lambda account_item: account_item[1]["customer_name"].lower())

        if account_options:
            account_choice = st.selectbox(
                "Conta da caderneta",
                options=["__new_account__"] + [account_id for account_id, _ in account_options],
                format_func=lambda account_id: (
                    "Nova conta"
                    if account_id == "__new_account__"
                    else accounts[account_id]["customer_name"]
                ),
                key=f"quick_dialog_account_{item_id}",
            )

            if account_choice == "__new_account__":
                new_customer_name = st.text_input("Cliente", key=f"quick_dialog_customer_{item_id}")
                account_note = st.text_area("Observacao da nota", key=f"quick_dialog_account_note_{item_id}")
            else:
                selected_account_id = account_choice
        else:
            st.info("Nenhuma conta aberta. Informe o cliente para criar uma nota.")
            new_customer_name = st.text_input("Cliente", key=f"quick_dialog_customer_{item_id}")
            account_note = st.text_area("Observacao da nota", key=f"quick_dialog_account_note_{item_id}")
    else:
        note = st.text_input("Obs.", key=f"quick_dialog_note_{item_id}")

    submitted = st.button("Adicionar", key=f"quick_dialog_submit_{item_id}", use_container_width=True)

    if submitted:
        if send_to_account:
            if selected_account_id is None:
                if not new_customer_name.strip():
                    st.warning("Informe o cliente da caderneta.")
                    return
                selected_account_id = create_account(accounts, new_customer_name, account_note)

            add_item(accounts, selected_account_id, item_name, quantity, item_price)
            if is_food_item:
                account_customer_name = accounts[selected_account_id]["customer_name"]
                add_kitchen_order(
                    kitchen_orders,
                    item_name,
                    quantity,
                    order_customer_name or account_customer_name,
                    account_note,
                    "Caderneta",
                    item_price,
                )
            st.session_state.quick_sale_item_id = None
            st.success(f"Item enviado para caderneta as {now_label()}.")
            st.rerun()

        if not payment_method:
            st.warning("Selecione um metodo de pagamento.")
            return

        if not cash_session_id:
            st.warning("Abra o caixa antes de registrar saidas.")
            return

        add_sale(sales, item_name, quantity, item_price, payment_method, note, order_customer_name, cash_session_id)
        if is_food_item:
            add_kitchen_order(
                kitchen_orders,
                item_name,
                quantity,
                order_customer_name,
                note,
                "Venda",
                item_price,
                payment_method,
            )
            st.session_state.quick_sale_item_id = None
            st.success(f"Venda registrada e pedido enviado para cozinha as {now_label()}.")
            st.rerun()

        st.session_state.quick_sale_item_id = None
        st.success(f"Venda registrada as {now_label()}.")
        st.rerun()


def render_sales_tab(accounts: dict, sales: dict, kitchen_orders: dict, menu: dict, cash_sessions: dict) -> None:
    st.markdown('<h2 class="section-title">Saidas da adega</h2>', unsafe_allow_html=True)

    payment_options = ["Dinheiro", "Pix", "Cartao"]
    active_session_id, active_session = active_cash_session(cash_sessions)
    if active_session_id is None:
        st.warning("Caixa fechado. Abra o caixa no Admin antes de registrar saidas.")
    else:
        st.caption(f"Caixa aberto desde {display_datetime(active_session.get('opened_at'))}.")

    st.markdown('<h2 class="section-title">Cardapio aberto</h2>', unsafe_allow_html=True)

    if menu:
        category_cols = st.columns(2)
        for col, category_name in zip(category_cols, MENU_CATEGORIES):
            with col:
                st.markdown(f"### {category_name}")
                category_items = menu_items_by_category(menu, category_name)
                if not category_items:
                    st.info(f"Nenhum item em {category_name.lower()}.")
                    continue

                for item_id, item in category_items:
                    with st.container(border=True):
                        st.markdown('<span class="quick-menu-row-marker"></span>', unsafe_allow_html=True)
                        item_cols = st.columns([2.4, 0.9, 1])
                        item_cols[0].write(item["name"])
                        item_cols[1].write(money(float(item["price"])))
                        if item_cols[2].button("Adicionar", key=f"quick_sale_{item_id}", use_container_width=True):
                            st.session_state.quick_sale_item_id = item_id
                            st.rerun()
    else:
        st.info("Cadastre itens na aba Cardapio para registrar vendas sem digitar nome e valor.")

    quick_sale_item_id = st.session_state.quick_sale_item_id
    if quick_sale_item_id in menu:
        show_quick_sale_dialog(accounts, sales, kitchen_orders, menu, quick_sale_item_id, payment_options, active_session_id)
    elif quick_sale_item_id is not None:
        st.session_state.quick_sale_item_id = None

    return

def render_admin_login() -> None:
    st.markdown('<h2 class="section-title">Login admin</h2>', unsafe_allow_html=True)

    if st.session_state.admin_logged_in:
        st.success("Admin conectado.")
        if st.button("Sair do admin"):
            st.session_state.admin_logged_in = False
            st.rerun()
        return

    with st.form("admin_login_form"):
        password = st.text_input("Senha", type="password")
        submitted = st.form_submit_button("Entrar")

    if submitted:
        if password == ADMIN_PASSWORD:
            st.session_state.admin_logged_in = True
            st.success("Login admin efetuado.")
            st.rerun()
        else:
            st.warning("Senha invalida.")


def render_cash_control(cash_sessions: dict, sales: dict) -> None:
    st.markdown('<h2 class="section-title">Controle de caixa</h2>', unsafe_allow_html=True)
    active_session_id, active_session = active_cash_session(cash_sessions)

    if active_session_id is None:
        st.info("Nenhum caixa aberto.")
        if st.button("Abrir caixa", key="open_cash_session"):
            open_cash_session(cash_sessions)
            st.success("Caixa aberto.")
            st.rerun()
        return

    session_sales = sales_for_cash_session(sales, active_session_id)
    total = sum(sale_total(sale) for sale in session_sales.values())
    quantity = sum(float(sale.get("quantity", 0)) for sale in session_sales.values())

    st.success(f"Caixa aberto desde {display_datetime(active_session.get('opened_at'))}.")
    metric_cols = st.columns(3)
    metric_cols[0].metric("Total do caixa", money(total))
    metric_cols[1].metric("Itens vendidos", f"{quantity:g}")
    metric_cols[2].metric("Registros", str(len(session_sales)))

    if st.button("Fechar caixa", key="close_cash_session"):
        close_cash_session(cash_sessions, sales, active_session_id)
        st.success("Caixa fechado.")
        st.rerun()


def render_sales_summary_tab(sales: dict, cash_sessions: dict) -> None:
    st.markdown('<h2 class="section-title">Resumo de vendas</h2>', unsafe_allow_html=True)
    render_cash_control(cash_sessions, sales)

    session_options = sorted(cash_sessions.items(), key=lambda session_item: session_item[1].get("opened_at", ""), reverse=True)
    summary_mode_options = ["Caixa"] if session_options else []
    summary_mode_options.extend(["Diario", "Semanal", "Mensal"])
    summary_mode = st.radio(
        "Tipo de resumo",
        summary_mode_options,
        horizontal=True,
        key="sales_summary_mode",
    )

    if summary_mode == "Caixa":
        selected_session_id = st.selectbox(
            "Caixa do resumo",
            options=[session_id for session_id, _session in session_options],
            format_func=lambda session_id: cash_session_label(session_id, cash_sessions[session_id]),
            key="sales_summary_cash_session",
        )
        period_sales = sales_for_cash_session(sales, selected_session_id)
        summary_label = "caixa"
    else:
        st.markdown('<span class="summary-period-marker"></span>', unsafe_allow_html=True)
        period_sales = sales_for_period(sales, summary_mode)
        summary_label = summary_mode.lower()

    total_period = sum(sale_total(sale) for sale in period_sales.values())
    quantity_period = sum(float(sale.get("quantity", 0)) for sale in period_sales.values())
    total_all = sum(sale_total(sale) for sale in sales.values())

    metric_cols = st.columns(3)
    metric_cols[0].metric(f"Total {summary_label}", money(total_period))
    metric_cols[1].metric(f"Itens {summary_label}", f"{quantity_period:g}")
    metric_cols[2].metric("Total geral", money(total_all))

    st.markdown(f'<h2 class="section-title">Saidas do resumo {summary_label}</h2>', unsafe_allow_html=True)
    if not period_sales:
        st.info("Nenhuma saida registrada neste periodo.")
        return

    for group in grouped_sales(period_sales):
        label = (
            f'{group["description"]} | '
            f'{group["quantity"]:g} un. | '
            f'{money(group["total"])}'
        )

        with st.expander(label):
            st.caption("Registros individuais do periodo")

            entries = sorted(
                group["entries"],
                key=lambda entry: entry["sale"].get("created_at", ""),
                reverse=True,
            )
            for entry in entries:
                sale_id = entry["sale_id"]
                sale = entry["sale"]
                cols = st.columns([1.2, 0.8, 1, 1])
                cols[0].write(display_datetime(sale.get("created_at")))
                cols[1].write(f'{float(sale.get("quantity", 0)):g} un.')
                cols[2].write(money(entry["total"]))
                if cols[3].button("Remover", key=f"admin_delete_period_sale_{sale_id}"):
                    delete_sale(sales, sale_id)
                    st.success("Saida removida.")
                    st.rerun()

                render_sale_details(sale)


def render_kitchen_tab(kitchen_orders: dict, sales: dict) -> None:
    st.markdown('<h2 class="section-title">Cozinha</h2>', unsafe_allow_html=True)

    pending_orders = [
        (order_id, order)
        for order_id, order in kitchen_orders.items()
        if order.get("status", "pending") in {"pending", "started"}
    ]
    pending_orders.sort(key=lambda order_item: order_item[1].get("created_at", ""))

    if not pending_orders:
        st.info("Nenhum pedido pendente na cozinha.")
        return

    for position, (order_id, order) in enumerate(pending_orders, start=1):
        with st.container(border=True):
            status = order.get("status", "pending")
            status_label = "Iniciada" if status == "started" else "Pendente"
            cols = st.columns([0.55, 2.4, 0.85, 1.25, 0.95, 1, 1])
            cols[0].write(f"#{position}")
            cols[1].markdown(f"**{escape(order.get('description', ''))}**")
            cols[2].write(f'{float(order.get("quantity", 0)):g} un.')
            cols[3].write(order.get("customer_name") or "Sem cliente")
            cols[4].write(status_label)

            if status == "started":
                cols[5].button("Iniciada", key=f"started_kitchen_{order_id}", disabled=True)
            elif cols[5].button("Iniciar", key=f"start_kitchen_{order_id}"):
                start_kitchen_order(kitchen_orders, order_id)
                st.success("Porcao iniciada.")
                st.rerun()

            if cols[6].button("Concluir", key=f"complete_kitchen_{order_id}"):
                complete_kitchen_order(kitchen_orders, order_id)
                st.success("Pedido concluido.")
                st.rerun()

            if order.get("note"):
                st.markdown(
                    f'<p class="kitchen-order-note">Obs.: {escape(order["note"])}</p>',
                    unsafe_allow_html=True,
                )


def render_kitchen_status_panel(kitchen_orders: dict) -> None:
    active_orders = [
        (order_id, order)
        for order_id, order in kitchen_orders.items()
        if order.get("status", "pending") in {"pending", "started"}
    ]
    active_orders.sort(key=lambda order_item: order_item[1].get("created_at", ""))

    st.markdown('<div class="kitchen-status-panel-title">Porcoes na cozinha</div>', unsafe_allow_html=True)

    if not active_orders:
        st.info("Nenhuma porcao em preparo.")
        return

    for position, (_order_id, order) in enumerate(active_orders, start=1):
        status = order.get("status", "pending")
        status_label = kitchen_status_label(status)
        customer = order.get("customer_name") or "Sem cliente"
        note = order.get("note", "").strip()
        note_markup = f'<p class="kitchen-status-note">Obs.: {escape(note)}</p>' if note else ""

        st.markdown(
            f"""
            <div class="kitchen-status-card">
                <div class="kitchen-status-card-top">
                    <span>#{position}</span>
                    <span class="kitchen-status-badge {escape(status)}">{escape(status_label)}</span>
                </div>
                <strong>{escape(order.get("description", ""))}</strong>
                <p>{float(order.get("quantity", 0)):g} un. | {escape(customer)}</p>
                {note_markup}
            </div>
            """,
            unsafe_allow_html=True,
        )


def apply_styles() -> None:
    st.markdown(
        """
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Bangers&display=swap');

            :root {
                --bg: #04110b;
                --ink: #fff8ed;
                --muted: #c5d6bf;
                --line: #24492f;
                --panel: #071c11;
                --panel-2: #0d2b19;
                --field: #06140d;
                --amber: #ffd21f;
                --brand-font: "Bangers", "Impact", "Arial Black", sans-serif;
            }

            .stApp {
                background:
                    radial-gradient(circle at top left, rgba(255, 210, 31, .14), transparent 28rem),
                    linear-gradient(180deg, #062013 0%, var(--bg) 100%);
                color: var(--ink);
            }

            .stApp * {
                font-family: var(--brand-font);
                letter-spacing: .035em;
            }

            .block-container {
                max-width: 1220px;
                padding-bottom: 3rem;
                padding-top: .85rem;
            }

            header[data-testid="stHeader"],
            div[data-testid="stToolbar"],
            div[data-testid="collapsedControl"] {
                display: none;
            }

            .brand-hero {
                align-items: center;
                background: linear-gradient(135deg, rgba(255, 210, 31, .98), rgba(26, 116, 62, .92) 58%, rgba(31, 95, 209, .80));
                border: 1px solid #d4aa13;
                border-radius: 8px;
                box-shadow: 0 20px 42px rgba(0, 0, 0, .38);
                display: grid;
                gap: 1rem;
                grid-template-columns: 4rem minmax(0, 1fr);
                margin-bottom: 1.1rem;
                padding: .95rem 1.05rem;
            }

            .brand-kicker {
                color: #161006;
                display: block;
                font-size: .74rem;
                font-weight: 900;
                letter-spacing: .08em;
                text-transform: uppercase;
            }

            .brand-title {
                color: #100b05;
                display: block;
                font-size: clamp(1.65rem, 4vw, 2.45rem);
                font-weight: 900;
                line-height: 1;
                margin-top: .2rem;
            }

            .brand-logo-slot {
                align-items: center;
                background: rgba(255, 255, 255, .34);
                border: 2px solid rgba(16, 11, 5, .32);
                border-radius: 999px;
                color: #100b05;
                display: flex;
                font-size: 1.25rem;
                font-weight: 900;
                height: 4rem;
                justify-content: center;
                overflow: hidden;
                width: 4rem;
            }

            .brand-logo-slot img {
                height: 100%;
                object-fit: cover;
                width: 100%;
            }

            section[data-testid="stSidebar"] .brand-hero {
                box-shadow: 0 12px 24px rgba(0, 0, 0, .28);
                gap: .55rem;
                grid-template-columns: 3rem minmax(0, 1fr);
                margin: .25rem 0 1rem;
                padding: .65rem .7rem;
            }

            section[data-testid="stSidebar"] .brand-kicker {
                font-size: .54rem;
                line-height: 1.15;
            }

            section[data-testid="stSidebar"] .brand-title {
                font-size: 1.08rem;
                line-height: 1.05;
                overflow-wrap: anywhere;
            }

            section[data-testid="stSidebar"] .brand-logo-slot {
                font-size: .9rem;
                height: 3rem;
                width: 3rem;
            }

            .section-title {
                color: var(--ink);
                font-size: 1.1rem;
                font-weight: 800;
                letter-spacing: .05em;
                margin: .25rem 0 .85rem;
            }

            .kitchen-order-note {
                color: var(--ink);
                font-size: 1rem;
                line-height: 1.25;
                margin: .35rem 0 0;
                overflow-wrap: anywhere;
            }

            div[data-testid="stForm"],
            div[data-testid="stVerticalBlockBorderWrapper"],
            div[data-testid="stExpander"],
            div[data-testid="stDialog"] div[role="dialog"] {
                background: var(--panel);
                border: 1px solid var(--line);
                border-radius: 8px;
                box-shadow: 0 18px 36px rgba(0, 0, 0, .28);
            }

            div[data-testid="stForm"] {
                padding: 1rem;
            }

            section[data-testid="stSidebar"] {
                background: linear-gradient(180deg, #071c11, #04110b);
                border-right: 1px solid var(--line);
            }

            .sidebar-title {
                color: var(--ink);
                font-size: 1.35rem;
                font-weight: 900;
                margin: .25rem 0 .8rem;
            }

            .kitchen-status-panel-action {
                border-top: 1px solid #1a5131;
                margin-top: .9rem;
                padding-top: .9rem;
            }

            .kitchen-status-panel-title {
                color: var(--ink);
                font-size: 1rem;
                font-weight: 900;
                margin: .25rem 0 .55rem;
                text-transform: uppercase;
            }

            .kitchen-status-card {
                background: var(--panel);
                border: 1px solid #1a5131;
                border-radius: 8px;
                color: var(--ink);
                margin-bottom: .55rem;
                padding: .65rem .7rem;
            }

            .kitchen-status-card-top {
                align-items: center;
                display: flex;
                justify-content: space-between;
                gap: .5rem;
                margin-bottom: .3rem;
            }

            .kitchen-status-card strong,
            .kitchen-status-card p {
                display: block;
                margin: 0;
                overflow-wrap: anywhere;
            }

            .kitchen-status-card p {
                color: var(--muted);
                font-size: .88rem;
                margin-top: .2rem;
            }

            .kitchen-status-badge {
                border-radius: 999px;
                color: #171006;
                font-size: .72rem;
                font-weight: 900;
                padding: .18rem .45rem;
            }

            .kitchen-status-badge.pending {
                background: #ffd21f;
            }

            .kitchen-status-badge.started {
                background: #8dd7ff;
            }

            .kitchen-status-note {
                color: var(--ink) !important;
            }

            div[data-testid="stRadio"] [role="radiogroup"] {
                display: flex;
                flex-direction: column;
                gap: .55rem;
            }

            div[data-testid="stRadio"] label {
                background: #092216;
                border: 1px solid #1a5131;
                border-radius: 8px;
                color: #d8e9d4;
                min-height: 3rem;
                padding: .25rem .7rem;
            }

            div[data-testid="stRadio"] label:has(input:checked) {
                background: #3f3108;
                border-color: var(--amber);
                color: #fff3b0;
            }

            .account-card {
                background: linear-gradient(180deg, rgba(13, 51, 31, .98), rgba(7, 28, 17, .98));
                border: 1px solid #1a5131;
                border-left: 5px solid var(--amber);
                border-radius: 8px;
                box-shadow: 0 18px 36px rgba(0, 0, 0, .28);
                min-height: 150px;
                margin-bottom: .55rem;
                padding: 1rem;
            }

            .account-card h3 {
                color: var(--ink);
                font-size: 1.12rem;
                line-height: 1.15;
                margin: 0 0 .45rem 0;
                overflow-wrap: anywhere;
            }

            .account-card p {
                color: #dce9df;
                margin: .25rem 0;
            }

            .account-card .muted {
                color: var(--muted);
                font-size: .8rem;
                font-weight: 700;
                text-transform: uppercase;
            }

            .account-card .total {
                color: #fff1c7;
                font-size: 1.45rem;
                font-weight: 900;
                margin-top: .55rem;
            }

            div[data-testid="stMetric"] {
                background: linear-gradient(180deg, #47380a, #171407);
                border: 1px solid var(--line);
                border-left: 5px solid var(--amber);
                border-radius: 8px;
                padding: .85rem 1rem;
            }

            [data-testid="stMetricLabel"],
            [data-testid="stMetricValue"],
            div[data-testid="stTextInput"] label,
            div[data-testid="stTextArea"] label,
            div[data-testid="stNumberInput"] label,
            div[data-testid="stSelectbox"] label {
                color: var(--ink);
                font-weight: 800;
            }

            div[data-testid="stTextInput"] input,
            div[data-testid="stTextArea"] textarea,
            div[data-testid="stNumberInput"] input,
            div[data-baseweb="select"] > div {
                background: var(--field);
                border: 1px solid #4a3436;
                border-radius: 8px;
                color: var(--ink);
                font-size: 1.05rem;
                font-weight: 700;
            }

            .stButton > button,
            .stFormSubmitButton > button {
                background: linear-gradient(180deg, #ffd21f, #d9a90f);
                border-color: var(--amber);
                border-radius: 8px;
                color: #171006;
                font-size: 1.05rem;
                font-weight: 800;
                min-height: 3rem;
                width: 100%;
            }

            .stButton > button:hover,
            .stFormSubmitButton > button:hover {
                background: linear-gradient(180deg, #ffe36a, #e6b717);
                border-color: #ffe36a;
                color: #171006;
            }

            div[data-testid="column"]:has(#new-account-action) {
                display: flex;
                justify-content: flex-end;
                padding-top: .15rem;
            }

            div[data-testid="column"]:has(#new-account-action) .stButton > button {
                align-items: center;
                border: 2px solid var(--amber);
                display: flex;
                font-size: 2.25rem;
                height: 5rem;
                justify-content: center;
                line-height: 1;
                min-height: 5rem;
                padding: 0;
                width: 5rem;
            }

            .menu-item-row-marker,
            .quick-menu-row-marker,
            .summary-period-marker,
            div[data-testid="stMarkdownContainer"]:has(.menu-item-row-marker),
            div[data-testid="stMarkdownContainer"]:has(.quick-menu-row-marker),
            div[data-testid="stMarkdownContainer"]:has(.menu-edit-action),
            div[data-testid="stMarkdownContainer"]:has(.summary-period-marker) {
                display: none;
            }

            div[data-testid="stVerticalBlock"]:has(.summary-period-marker)
            div[data-testid="stRadio"] [role="radiogroup"] {
                flex-direction: row;
                flex-wrap: wrap;
                gap: .45rem;
            }

            div[data-testid="stVerticalBlock"]:has(.summary-period-marker)
            div[data-testid="stRadio"] label {
                min-height: 2.35rem;
                padding: .15rem .85rem;
            }

            div[data-testid="stVerticalBlockBorderWrapper"]:has(.quick-menu-row-marker) {
                box-shadow: none;
                margin-bottom: .28rem;
                min-height: 0;
            }

            div[data-testid="stVerticalBlockBorderWrapper"]:has(.quick-menu-row-marker) > div {
                padding: .18rem .45rem;
            }

            div[data-testid="stVerticalBlockBorderWrapper"]:has(.quick-menu-row-marker)
            div[data-testid="stHorizontalBlock"] {
                align-items: center;
                gap: .35rem;
            }

            div[data-testid="stVerticalBlockBorderWrapper"]:has(.quick-menu-row-marker)
            div[data-testid="column"] {
                align-items: center;
                display: flex;
                min-height: 1.9rem;
            }

            div[data-testid="stVerticalBlockBorderWrapper"]:has(.quick-menu-row-marker)
            .stMarkdown,
            div[data-testid="stVerticalBlockBorderWrapper"]:has(.quick-menu-row-marker)
            p {
                margin: 0;
            }

            div[data-testid="stVerticalBlockBorderWrapper"]:has(.quick-menu-row-marker)
            .stButton > button {
                font-size: .82rem;
                min-height: 1.95rem;
                padding: 0 .45rem;
            }

            div[data-testid="stVerticalBlockBorderWrapper"]:has(.menu-item-row-marker) {
                box-shadow: none;
                margin-bottom: .25rem;
                min-height: 0;
            }

            div[data-testid="stVerticalBlockBorderWrapper"]:has(.menu-item-row-marker) > div {
                padding: .18rem .45rem;
            }

            div[data-testid="stVerticalBlockBorderWrapper"]:has(.menu-item-row-marker)
            div[data-testid="stHorizontalBlock"] {
                align-items: center;
                gap: .35rem;
            }

            div[data-testid="stVerticalBlockBorderWrapper"]:has(.menu-item-row-marker)
            div[data-testid="column"] {
                align-items: center;
                display: flex;
                min-height: 1.75rem;
            }

            div[data-testid="stVerticalBlockBorderWrapper"]:has(.menu-item-row-marker)
            .stMarkdown,
            div[data-testid="stVerticalBlockBorderWrapper"]:has(.menu-item-row-marker)
            p {
                margin: 0;
            }

            div[data-testid="column"]:has(.menu-edit-action) .stButton > button {
                align-items: center;
                background: #17182f;
                border-color: #4a5573;
                color: var(--ink);
                display: flex;
                font-size: .82rem;
                height: 1.85rem;
                justify-content: center;
                line-height: 1;
                min-height: 1.85rem;
                padding: 0 .55rem;
                width: 100%;
            }

            div[data-testid="column"]:has(.menu-edit-action) .stButton > button:hover,
            div[data-testid="column"]:has(.menu-edit-action) .stButton > button:focus,
            div[data-testid="column"]:has(.menu-edit-action) .stButton > button:active {
                background: #252849;
                border-color: var(--amber);
                color: var(--ink);
            }

            .stAlert {
                background: var(--panel-2);
                color: var(--ink);
            }

            .stCaptionContainer,
            .stMarkdown p,
            div[data-testid="stExpander"] p {
                color: var(--muted);
            }

            .stMarkdown p,
            .stCaptionContainer,
            label,
            div[data-testid="stMetricLabel"],
            div[data-testid="stMetricValue"],
            div[data-testid="stExpander"] summary,
            div[data-testid="stExpander"] p,
            div[data-testid="stExpander"] span,
            div[data-testid="stExpander"] button,
            div[data-testid="stNumberInput"] input,
            div[data-baseweb="select"] {
                line-height: 1.28;
            }

            .stMarkdown p,
            div[data-testid="stExpander"] summary,
            div[data-testid="stExpander"] p,
            div[data-testid="stExpander"] span {
                overflow-wrap: anywhere;
                white-space: normal;
            }

            div[data-testid="stExpander"] summary {
                min-height: 2.35rem;
                padding-bottom: .35rem;
                padding-top: .35rem;
            }

            div[data-testid="stExpander"] summary p {
                font-size: .95rem;
                line-height: 1.25;
            }

            div[data-testid="stMetric"] {
                min-height: 5.9rem;
            }

            [data-testid="stMetricLabel"] {
                font-size: .82rem;
                line-height: 1.2;
                white-space: normal;
            }

            [data-testid="stMetricValue"] {
                font-size: 1.85rem;
                line-height: 1.08;
            }

            div[data-testid="stNumberInput"] {
                min-width: 8rem;
            }

            div[data-testid="stNumberInput"] input,
            div[data-baseweb="select"] > div,
            div[data-testid="stTextInput"] input {
                min-height: 2.55rem;
            }

            @media (max-width: 720px) {
                .block-container {
                    padding-left: .85rem;
                    padding-right: .85rem;
                }

                .brand-hero {
                    grid-template-columns: 3.35rem minmax(0, 1fr);
                }

                .brand-logo-slot {
                    height: 3.35rem;
                    width: 3.35rem;
                }
            }
        </style>
        """,
        unsafe_allow_html=True,
    )


apply_styles()

accounts = load_accounts()
menu = load_menu()
sales = load_sales()
kitchen_orders = load_kitchen_orders()
cash_sessions = load_cash_sessions()

if "open_account_id" not in st.session_state:
    st.session_state.open_account_id = None

if "show_new_account_dialog" not in st.session_state:
    st.session_state.show_new_account_dialog = False

if "edit_menu_item_id" not in st.session_state:
    st.session_state.edit_menu_item_id = None

if "quick_sale_item_id" not in st.session_state:
    st.session_state.quick_sale_item_id = None

if "show_kitchen_status_panel" not in st.session_state:
    st.session_state.show_kitchen_status_panel = False

if "admin_logged_in" not in st.session_state:
    st.session_state.admin_logged_in = False

with st.sidebar:
    st.markdown(brand_header_markup(), unsafe_allow_html=True)
    st.markdown('<div class="sidebar-title">Menu</div>', unsafe_allow_html=True)
    menu_options = ["Saidas da adega", "Caderneta do fiado", "Login admin"]
    if st.session_state.admin_logged_in:
        menu_options = [
            "Saidas da adega",
            "Caderneta do fiado",
            "Admin",
            "Resumo de vendas",
            "Cardapio",
            "Sair admin",
            "Cozinha",
        ]

    selected_page = st.radio(
        "Navegacao",
        menu_options,
        label_visibility="collapsed",
    )

    if selected_page == "Saidas da adega":
        st.markdown('<div class="kitchen-status-panel-action"></div>', unsafe_allow_html=True)
        panel_label = "Fechar status da cozinha" if st.session_state.show_kitchen_status_panel else "Status da cozinha"
        if st.button(panel_label, key="toggle_kitchen_status_panel"):
            st.session_state.show_kitchen_status_panel = not st.session_state.show_kitchen_status_panel
            st.rerun()

        if st.session_state.show_kitchen_status_panel:
            render_kitchen_status_panel(kitchen_orders)

    else:
        st.session_state.show_kitchen_status_panel = False

if selected_page == "Caderneta do fiado":
    render_accounts_tab(accounts, menu)
elif selected_page == "Saidas da adega":
    render_sales_tab(accounts, sales, kitchen_orders, menu, cash_sessions)
elif selected_page == "Cozinha" and st.session_state.admin_logged_in:
    render_kitchen_tab(kitchen_orders, sales)
elif selected_page == "Login admin":
    render_admin_login()
elif selected_page == "Admin":
    render_admin_login()
elif selected_page == "Resumo de vendas" and st.session_state.admin_logged_in:
    render_sales_summary_tab(sales, cash_sessions)
elif selected_page == "Cardapio" and st.session_state.admin_logged_in:
    render_menu_tab(menu)
elif selected_page == "Sair admin":
    st.session_state.admin_logged_in = False
    st.success("Admin desconectado.")
    st.rerun()
else:
    render_admin_login()
