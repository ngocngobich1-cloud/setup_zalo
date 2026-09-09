const ui = {
  sync: document.querySelector("#data-sync"),
  toolbar: document.querySelector("#data-toolbar"),
  search: document.querySelector("#data-search"),
  product: document.querySelector("#data-product"),
  stage: document.querySelector("#data-stage"),
  dateFrom: document.querySelector("#data-date-from"),
  dateTo: document.querySelector("#data-date-to"),
  dateNote: document.querySelector("#data-date-note"),
  sort: document.querySelector("#data-sort"),
  pageSize: document.querySelector("#data-page-size"),
  previous: document.querySelector("#data-prev"),
  next: document.querySelector("#data-next"),
  pageLabel: document.querySelector("#data-page-label"),
  tableBody: document.querySelector("#data-table-body"),
  cards: document.querySelector("#data-cards"),
  empty: document.querySelector("#data-empty"),
  message: document.querySelector("#data-message"),
  lastSync: document.querySelector("#data-last-sync"),
  received: document.querySelector("#data-received"),
  saved: document.querySelector("#data-saved"),
  skipped: document.querySelector("#data-skipped"),
  totalCustomers: document.querySelector("#data-total-customers"),
  detail: document.querySelector("#data-detail"),
  detailBackdrop: document.querySelector("#data-detail-backdrop"),
  detailClose: document.querySelector("#data-detail-close"),
  detailTitle: document.querySelector("#data-detail-title"),
  detailBody: document.querySelector("#data-detail-body"),
};

const state = { loaded: false, loading: false, syncing: false, page: 1, totalPages: 1 };
let searchTimer = null;

function text(tag, value, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value ?? "—";
  return node;
}

function money(value) {
  return value === null || value === undefined
    ? "—"
    : `${new Intl.NumberFormat("vi-VN").format(value)} ₫`;
}

function date(value, withTime = false) {
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.DateTimeFormat("vi-VN", withTime
    ? { dateStyle: "short", timeStyle: "short" }
    : { dateStyle: "short" }).format(new Date(Number(value)));
}

async function json(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Không tải được dữ liệu.");
  return body;
}

function queryString() {
  const [sort, dir] = ui.sort.value.split(":");
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: ui.pageSize.value,
    sort,
    dir,
  });
  for (const [key, value] of [
    ["q", ui.search.value.trim()],
    ["product", ui.product.value],
    ["stage", ui.stage.value],
    ["dateFrom", ui.dateFrom.value],
    ["dateTo", ui.dateTo.value],
  ]) if (value) params.set(key, value);
  return params.toString();
}

function fillSelect(select, options, placeholder, valueKey, labelKey) {
  const selected = select.value;
  select.replaceChildren(new Option(placeholder, ""));
  for (const option of options) {
    const value = valueKey ? option[valueKey] : option;
    const label = labelKey ? option[labelKey] : option;
    select.add(new Option(label, value));
  }
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

function productText(products) {
  return products.length ? products.map((product) => product.product_name).join(", ") : "—";
}

function makeRow(customer) {
  const row = document.createElement("tr");
  row.tabIndex = 0;
  row.dataset.customerId = customer.website_customer_id;
  for (const value of [
    customer.name || "—", customer.phone || "—", customer.email || "—",
    productText(customer.products), date(customer.purchase_date), customer.stage || "—",
    money(customer.total_spent),
  ]) row.append(text("td", value));
  return row;
}

function labeledValue(label, value) {
  const line = document.createElement("div");
  line.className = "data-card-line";
  line.append(text("small", label), text("span", value));
  return line;
}

function makeCard(customer) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "data-card";
  card.dataset.customerId = customer.website_customer_id;
  card.append(
    text("strong", customer.name || "Chưa có tên"),
    labeledValue("Số điện thoại", customer.phone || "—"),
    labeledValue("Email", customer.email || "—"),
    labeledValue("Sản phẩm", productText(customer.products)),
    labeledValue("Ngày mua", date(customer.purchase_date)),
    labeledValue("Tình trạng", customer.stage || "—"),
    labeledValue("Tổng đã chi", money(customer.total_spent))
  );
  return card;
}

function renderList(data) {
  ui.tableBody.replaceChildren(...data.items.map(makeRow));
  ui.cards.replaceChildren(...data.items.map(makeCard));
  ui.empty.classList.toggle("hidden", data.items.length > 0);
  state.totalPages = data.totalPages;
  ui.pageLabel.textContent = `Trang ${data.page} / ${data.totalPages} · ${data.total} khách hàng`;
  ui.previous.disabled = data.page <= 1;
  ui.next.disabled = data.page >= data.totalPages;
  const dateEnabled = Boolean(data.capabilities?.purchaseDateFilter);
  ui.dateFrom.disabled = !dateEnabled;
  ui.dateTo.disabled = !dateEnabled;
  ui.dateNote.classList.toggle("hidden", dateEnabled);
  fillSelect(ui.product, data.filters?.products || [], "Sản phẩm", "product_key", "product_name");
  fillSelect(ui.stage, data.filters?.stages || [], "Tình trạng");
}

async function loadList() {
  if (state.loading) return;
  state.loading = true;
  ui.message.textContent = "Đang tải dữ liệu…";
  try {
    const data = await json(`/api/data/customers?${queryString()}`);
    renderList(data);
    ui.message.textContent = "";
  } catch (error) {
    ui.message.textContent = error.message;
  } finally {
    state.loading = false;
  }
}

async function loadStatus() {
  try {
    const data = await json("/api/data/sync-status");
    const run = data.run;
    ui.lastSync.textContent = run?.finished_at ? date(run.finished_at, true)
      : data.status === "INTERRUPTED" ? "Bị gián đoạn" : "Chưa đồng bộ";
    ui.received.textContent = run ? String(run.received_count) : "—";
    ui.saved.textContent = run ? String(run.applied_count) : "—";
    ui.skipped.textContent = run ? String(run.skipped_count) : "—";
    ui.totalCustomers.textContent = String(data.total_customers || 0);
    if (!state.syncing) {
      ui.sync.disabled = data.status === "RUNNING";
      ui.sync.textContent = data.status === "RUNNING" ? "Đang đồng bộ…" : "Đồng bộ ngay";
    }
  } catch (error) {
    ui.message.textContent = error.message;
  }
}

async function syncNow() {
  if (state.syncing) return;
  state.syncing = true;
  ui.sync.disabled = true;
  ui.sync.textContent = "Đang đồng bộ…";
  ui.message.textContent = "Đang lấy dữ liệu từ Website…";
  try {
    await json("/api/data/sync", { method: "POST" });
    state.page = 1;
    ui.message.textContent = "Đồng bộ Website hoàn tất.";
    await Promise.all([loadList(), loadStatus()]);
  } catch (error) {
    ui.message.textContent = error.message;
    await loadStatus();
  } finally {
    state.syncing = false;
    ui.sync.disabled = false;
    ui.sync.textContent = "Đồng bộ ngay";
  }
}

function detailSection(title, values) {
  const section = document.createElement("section");
  section.append(text("h4", title));
  if (!values.length) section.append(text("p", "—", "data-detail-empty"));
  else section.append(...values);
  return section;
}

async function openDetail(id) {
  ui.detail.classList.remove("hidden");
  ui.detailBackdrop.classList.remove("hidden");
  ui.detailBody.replaceChildren(text("p", "Đang tải…"));
  try {
    const data = await json(`/api/data/customers/${encodeURIComponent(id)}`);
    const customer = data.customer;
    ui.detailTitle.textContent = customer.name || "Chi tiết khách hàng";
    const overview = document.createElement("div");
    overview.className = "data-detail-grid";
    overview.append(
      labeledValue("Số điện thoại", customer.phone || "—"),
      labeledValue("Email", customer.email || "—"),
      labeledValue("Tình trạng", customer.stage || "—"),
      labeledValue("Tổng đã chi", money(customer.total_spent))
    );
    const products = data.products.map((item) => text("p", item.product_name));
    const orders = data.orders.map((item) => {
      const line = document.createElement("p");
      line.textContent = `${item.order_id} · ${item.product_name || "—"} · ${date(item.purchase_date)} · ${money(item.amount)}`;
      return line;
    });
    const tracking = data.emailTracking?.hasData
      ? `Trạng thái gần nhất: ${data.emailTracking.status}`
      : "Chưa có dữ liệu theo dõi email";
    ui.detailBody.replaceChildren(
      overview,
      detailSection("Sản phẩm", products),
      detailSection("Đơn hàng", orders),
      detailSection("Theo dõi email", [text("p", tracking)])
    );
  } catch (error) {
    ui.detailBody.replaceChildren(text("p", error.message, "data-message"));
  }
}

function closeDetail() {
  ui.detail.classList.add("hidden");
  ui.detailBackdrop.classList.add("hidden");
}

ui.sync?.addEventListener("click", syncNow);
ui.toolbar?.addEventListener("change", () => { state.page = 1; void loadList(); });
ui.search?.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => { state.page = 1; void loadList(); }, 250);
});
ui.pageSize?.addEventListener("change", () => { state.page = 1; void loadList(); });
ui.previous?.addEventListener("click", () => { if (state.page > 1) { state.page--; void loadList(); } });
ui.next?.addEventListener("click", () => { if (state.page < state.totalPages) { state.page++; void loadList(); } });
document.querySelector(".data-results")?.addEventListener("click", (event) => {
  const item = event.target.closest("[data-customer-id]");
  if (item) void openDetail(item.dataset.customerId);
});
ui.tableBody?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("[data-customer-id]");
  if (row) { event.preventDefault(); void openDetail(row.dataset.customerId); }
});
ui.detailClose?.addEventListener("click", closeDetail);
ui.detailBackdrop?.addEventListener("click", closeDetail);

export function napData() {
  if (state.loaded) return;
  state.loaded = true;
  void Promise.all([loadList(), loadStatus()]);
}
