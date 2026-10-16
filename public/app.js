const $ = (selector, root = document) => root.querySelector(selector);
const app = $("#app"),
  modal = $("#modal");
const state = {
  user: null,
  config: { business_name: "The Office of Yash SR: Payment Portal" },
  invoices: [],
  plans: [],
  customers: [],
  view: "overview",
  filter: "all",
  search: "",
  invoice: null,
};
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const money = (cents) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
const day = (value) =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(value.slice(0, 10) + "T12:00:00Z"))
    : "—";
const today = () => new Date().toISOString().slice(0, 10);
const initial = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((v) => v[0])
    .join("")
    .toUpperCase();
const isAdmin = () => state.user?.role === "admin";
const icon = (name, cls = "") =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    {
      logo: '<path d="M5 4v16h15M10 14l4-6 6 1"/>',
      grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
      invoice:
        '<path d="M6 3h9l4 4v14l-3-2-4 2-4-2-3 2V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5M9 12h6M9 16h4"/>',
      users:
        '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5"/>',
      plan: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18M8 16l2 2 5-4"/>',
      arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
      chevron: '<path d="m9 5 7 7-7 7"/>',
      down: '<path d="m6 9 6 6 6-6"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      wallet:
        '<path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v12H6a3 3 0 0 1-3-3V6M20 12h-5v5h5"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
      logout: '<path d="M9 4H4v16h5M14 8l4 4-4 4M8 12h13"/>',
      lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
      mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
      close: '<path d="m6 6 12 12M6 18 18 6"/>',
      print: '<path d="M7 8V3h10v5M7 17H3V8h18v9h-4M7 14h10v7H7zM17 11h1"/>',
      help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01"/>',
      alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
      settings:
        '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
      trend: '<path d="m3 17 6-6 4 4 8-10M15 5h6v6"/>',
      spark:
        '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
    }[name] || ""
  }</svg>`;
const badge = (status) =>
  `<span class="badge ${escape(status)}"><span class="status-dot"></span>${{ open: "Unpaid", overdue: "Overdue", partial: "Partially paid", paid: "Paid", pending: "Pending review", approved: "Approved", declined: "Declined" }[status] || escape(status)}</span>`;

async function api(path, body) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              ...(state.config.csrf_token
                ? { "X-Ledger-CSRF": state.config.csrf_token }
                : {}),
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(
      "Cannot reach the server. Check your connection and try again.",
    );
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      modal.close();
      renderLogin("Your session ended. Please sign in again.");
    }
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}
let toastTimer;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 4500);
}
function portalBrand(large = false) {
  return `<a class="brand ${large ? "brand-large" : ""}" href="/" aria-label="${escape(state.config.business_name)}"><img class="brand-logo" src="/brand/office-logo.png" alt="The Office of Yash Sunder Raj logo" width="240" height="100"><span class="brand-name">${escape(state.config.business_name)}</span></a>`;
}
function renderLogin(error = "") {
  app.innerHTML = `<main class="login-layout"><section class="login-story"><div class="login-brand">${portalBrand(true)}</div><div class="story-content"><span class="eyebrow">A CLEARER VIEW OF YOUR ACCOUNT</span><h1>Your account.<br>All in one place.</h1><p>View your invoices, understand every charge,<br class="desktop-only"> and find a payment plan that works for you.</p><div class="story-features"><span>${icon("invoice")} Itemized invoices</span><span>${icon("plan")} Flexible payment requests</span></div></div><p class="story-footer">The Office of Yash SR · Your payment portal</p></section><section class="login-panel"><div class="login-form-wrap"><span class="eyebrow">PAYMENT PORTAL</span><h2>Welcome back.</h2><p class="muted login-subtitle">Sign in to view your account.</p><form id="login-form"><label>Email address<input name="email" type="email" autocomplete="username" placeholder="you@example.com" required maxlength="254"></label><label>Password<input name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required maxlength="128"></label><p class="form-error" role="alert">${escape(error)}</p><button class="button primary full" type="submit">Sign in ${icon("arrow")}</button></form><p class="login-help">Need access or a password reset?<br>Contact The Office of Yash SR.</p>${state.config.demo ? `<div class="demo-box"><span class="eyebrow">EXPLORE THE PORTAL</span><p>Try an account with sample information.</p><div class="demo-buttons"><button class="button secondary" data-action="demo-admin">${icon("grid")} Admin demo</button><button class="button secondary" data-action="demo-customer">${icon("settings")} Customer demo</button></div></div>` : ""}<div class="secure-note">${icon("lock")} Private access. Clear information.</div></div><p class="login-bottom">${escape(state.config.business_name)}</p></section></main>`;
}
async function loadData() {
  const [invoices, plans, customers] = await Promise.all([
    api("/invoices"),
    api("/plans"),
    isAdmin() ? api("/customers") : Promise.resolve({ customers: [] }),
  ]);
  state.invoices = invoices.invoices;
  state.plans = plans.plans;
  state.customers = customers.customers;
}
async function signIn(email, password) {
  const { user } = await api("/login", { email, password });
  state.user = user;
  state.view = "overview";
  state.search = "";
  state.filter = "all";
  if (!user.must_change_password) await loadData();
  render();
}
const navItems = () => [
  ["overview", "grid", "Overview"],
  ["invoices", "invoice", "Invoices"],
  ...(isAdmin() ? [["customers", "users", "Customers"]] : []),
  ["plans", "plan", isAdmin() ? "Plan requests" : "Payment plans"],
];
function render() {
  if (!state.user) {
    renderLogin();
    return;
  }
  if (state.user.must_change_password) {
    renderPasswordRequired();
    return;
  }
  const pending = state.plans.filter((p) => p.status === "pending").length;
  app.innerHTML = `<div class="app-layout ${isAdmin() ? "admin-workspace" : "customer-workspace"}"><header class="site-header"><div class="header-inner">${portalBrand()}<nav class="top-navigation" aria-label="Main navigation">${[...navItems(), ["account", "settings", "Account"]].map(([view, i, label]) => `<button class="nav-item ${state.view === view ? "active" : ""}" data-view="${view}" ${state.view === view ? 'aria-current="page"' : ""}>${icon(i)}<span>${label}</span>${view === "plans" && pending ? `<span class="nav-count" aria-hidden="true">${pending}</span>` : ""}</button>`).join("")}</nav><div class="header-actions">${state.config.demo ? '<span class="demo-pill">Demo</span>' : ""}<button class="avatar profile-button" data-view="account" aria-label="Account settings">${escape(initial(state.user.full_name))}</button><button class="icon-button signout-button" data-action="logout" aria-label="Sign out">${icon("logout")}</button></div></div></header><div class="main-shell"><main id="main-content" tabindex="-1">${renderPage()}</main><footer class="app-footer"><span>${escape(state.config.business_name)}</span><span>${icon("lock")} Your account, privately and securely.</span></footer></div></div>`;
}
function heading(eyebrow, title, description, action = "") {
  return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}
const createButton = () =>
  `<button class="button primary" data-action="new-invoice">${icon("plus")} Create invoice</button>`;
function renderPage() {
  if (state.view === "overview") return overview();
  if (state.view === "invoices")
    return `${heading("KEEP EVERY DETAIL IN SIGHT", "Invoices", isAdmin() ? "Create invoices, track balances, and keep things moving." : "A clear view of what’s due, what’s paid, and everything in between.", isAdmin() ? createButton() : "")}<section class="panel">${invoiceToolbar()}<div id="invoice-results">${invoiceTable(state.invoices)}</div></section><p class="table-footnote">All amounts are in USD. Select an invoice to see its individual charges.</p>`;
  if (state.view === "customers") return customersPage();
  if (state.view === "plans") return plansPage();
  return `${heading("MAKE YOURSELF AT HOME", "Account settings", "Your details and sign-in security.")}<section class="panel account-panel"><div class="profile-large"><span class="avatar">${escape(initial(state.user.full_name))}</span><div><h2>${escape(state.user.full_name)}</h2><p class="muted">${escape(state.user.email)}</p></div></div><dl class="account-details"><div><dt>Account type</dt><dd>${isAdmin() ? "Administrator" : "Customer"}</dd></div><div><dt>Email address</dt><dd>${escape(state.user.email)}</dd></div></dl><div class="account-security"><div><h3>Password & security</h3><p class="muted">Choose a unique password with at least 12 characters.</p></div><button class="button secondary" data-action="change-password">Change password</button></div><div class="account-signout"><button class="text-button" data-action="logout">${icon("logout")} Sign out of your account</button></div></section>`;
}
function customerOverview() {
  const outstanding = state.invoices.reduce(
    (sum, invoice) => sum + invoice.balance,
    0,
  );
  const unpaid = state.invoices.filter((invoice) => invoice.balance > 0).length;
  return `<section class="customer-overview"><p class="balance-greeting">Welcome back, ${escape(state.user.full_name.split(" ")[0])}.</p><div class="balance-hero" aria-labelledby="total-due-title"><span class="balance-rule" aria-hidden="true"></span><h1 id="total-due-title">Total due</h1><p class="balance-value ${money(outstanding).length > 10 ? "long-amount" : ""}" aria-label="Total due ${money(outstanding)}">${money(outstanding)}</p><p class="balance-note">${unpaid ? `Across ${unpaid} outstanding invoice${unpaid === 1 ? "" : "s"}. All amounts in USD.` : "You’re all paid up. Thank you."}</p><div class="balance-actions"><button class="button primary" data-view="invoices">View invoices ${icon("arrow")}</button>${unpaid ? `<button class="text-button" data-view="invoices">Request a payment plan ${icon("arrow")}</button>` : ""}</div></div><p class="balance-bottom-note">Every charge, every payment, clearly accounted for.</p></section>`;
}
function overview() {
  if (!isAdmin()) return customerOverview();
  const outstanding = state.invoices.reduce(
    (sum, invoice) => sum + invoice.balance,
    0,
  );
  const overdue = state.invoices.filter(
    (invoice) => invoice.status === "overdue",
  );
  const collected = state.invoices.reduce(
    (sum, invoice) => sum + invoice.paid,
    0,
  );
  const pending = state.plans.filter((plan) => plan.status === "pending");
  const stats = [
    [
      "Outstanding balance",
      money(outstanding),
      "Across all unpaid invoices",
      "wallet",
    ],
    [
      "Overdue balance",
      money(overdue.reduce((sum, invoice) => sum + invoice.balance, 0)),
      `${overdue.length} overdue invoice${overdue.length === 1 ? "" : "s"}`,
      "clock",
    ],
    [
      "Payments received",
      money(collected),
      "Recorded payments, all time",
      "check",
    ],
    [
      "Customers",
      state.customers.length,
      "Registered customer accounts",
      "users",
    ],
  ];
  return `${heading("ADMINISTRATION", `Welcome back, ${escape(state.user.full_name.split(" ")[0])}.`, "A clear view of your accounts, invoices, and payment requests.", createButton())}<div class="stats-grid">${stats.map(([label, value, note, symbol]) => `<section class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon(symbol)}</span></div><strong>${value}</strong><span class="stat-note">${note}</span></section>`).join("")}</div><div class="overview-grid"><section class="panel recent-panel"><div class="panel-heading"><div><h2>Recent invoices <span class="count-label">${state.invoices.length}</span></h2><p>Choose an invoice to view its charges and payments.</p></div><button class="text-button" data-view="invoices">View all ${icon("arrow")}</button></div>${invoiceTable(state.invoices.slice(0, 5), true)}</section><aside class="overview-aside"><section class="panel side-panel"><div class="panel-heading compact"><h2>Plan requests</h2>${icon("plan")}</div><div class="request-number">${pending.length}<span>awaiting your review</span></div><p class="muted side-copy">Review customer proposals and send a response.</p><button class="button secondary full" data-view="plans">Review requests ${icon("arrow")}</button></section><section class="help-card"><span class="eyebrow">CUSTOMER ACCESS</span><h3>A personal place for every account.</h3><p>Add a customer to give them access to their invoices and payment plans.</p><button class="text-button" data-action="new-customer">Add customer ${icon("plus")}</button></section></aside></div>`;
}
function invoiceToolbar() {
  return `<div class="invoice-toolbar"><div class="tabs" aria-label="Invoice status">${[
    ["all", "All invoices"],
    ["unpaid", "Outstanding"],
    ["paid", "Paid"],
  ]
    .map(
      ([value, label]) =>
        `<button class="tab ${state.filter === value ? "active" : ""}" data-filter="${value}" aria-pressed="${state.filter === value}">${label}</button>`,
    )
    .join(
      "",
    )}</div><label class="search-box">${icon("search")}<input id="invoice-search" type="search" aria-label="Search invoices" placeholder="Search invoices…" value="${escape(state.search)}"></label></div>`;
}
function filteredInvoices(rows) {
  return rows.filter(
    (i) =>
      (state.filter === "all" ||
        (state.filter === "paid" ? i.balance === 0 : i.balance > 0)) &&
      `${i.number} ${i.description} ${i.customer_name}`
        .toLowerCase()
        .includes(state.search.toLowerCase()),
  );
}
function invoiceTable(rows, compact = false) {
  if (!compact) rows = filteredInvoices(rows);
  if (!rows.length)
    return `<div class="empty-state">${icon("invoice")}<h3>${state.search ? "No matching invoices" : state.filter === "all" ? "A fresh start." : "No invoices in this view."}</h3><p>${state.search ? "Try a different invoice number, title, or customer." : isAdmin() ? "Create an invoice to start keeping track of what’s due." : "Your invoices will appear here when they’re issued."}</p>${isAdmin() && !state.search ? createButton() : ""}</div>`;
  return `<div class="table-scroll"><table class="invoice-table"><thead><tr><th>Invoice / description</th>${isAdmin() ? "<th>Customer</th>" : ""}<th>Due date</th><th>Balance</th><th>Status</th><th><span class="sr-only">Details</span></th></tr></thead><tbody>${rows.map((i) => `<tr><td><button class="invoice-link" data-action="invoice" data-id="${i.id}"><span class="document-icon">${icon("invoice")}</span><span><strong>${escape(i.number)}</strong><small>${escape(i.description)}</small></span></button></td>${isAdmin() ? `<td><span class="customer-cell">${escape(i.customer_name)}</span></td>` : ""}<td class="nowrap">${day(i.due_date)}</td><td class="amount-cell"><strong>${money(i.balance)}</strong>${i.paid > 0 ? `<small>${money(i.total)} total</small>` : ""}</td><td>${badge(i.status)}</td><td><button class="icon-button" aria-label="View ${escape(i.number)}" data-action="invoice" data-id="${i.id}">${icon("chevron")}</button></td></tr>`).join("")}</tbody></table></div>`;
}
function customersPage() {
  return `${heading("PEOPLE BEHIND THE NUMBERS", "Customers", "Give every customer a simple, secure place to see their billing.", `<button class="button primary" data-action="new-customer">${icon("plus")} Add customer</button>`)}<section class="panel"><div class="panel-heading"><h2>All customers <span class="count-label">${state.customers.length}</span></h2></div>${
    state.customers.length
      ? `<div class="table-scroll"><table><thead><tr><th>Customer</th><th>Invoices</th><th>Outstanding</th><th>Account</th><th>Access</th></tr></thead><tbody>${state.customers
          .map((c) => {
            const invoices = state.invoices.filter(
              (i) => i.customer_id === c.id,
            );
            return `<tr><td><span class="customer-identity"><span class="avatar customer-avatar">${escape(initial(c.full_name))}</span><span><strong>${escape(c.full_name)}</strong><small>${escape(c.email)}</small></span></span></td><td>${invoices.length}</td><td class="amount-cell">${money(invoices.reduce((s, i) => s + i.balance, 0))}</td><td><span class="badge ${c.must_change_password ? "pending" : "paid"}">${c.must_change_password ? "First sign-in pending" : "Active"}</span></td><td><button class="text-button" data-action="reset-password" data-id="${c.id}">Reset password</button></td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : `<div class="empty-state">${icon("users")}<h3>Your first customer starts here.</h3><p>Add a customer, then create their first invoice.</p><button class="button primary" data-action="new-customer">${icon("plus")} Add customer</button></div>`
  }</section><div class="info-note">${icon("help")} Customer accounts are created by you. Share their temporary password securely; they’ll choose a new one at first sign-in. Emails are not sent automatically.</div>`;
}
function plansPage() {
  return `${heading("A LITTLE ROOM TO BREATHE", isAdmin() ? "Payment plan requests" : "Payment plans", isAdmin() ? "Review a proposal, leave a response, and find a way forward." : "Your requests and responses, all in one place.", !isAdmin() ? '<button class="button primary" data-view="invoices">Find an invoice ' + icon("arrow") + "</button>" : "")}<div class="plan-list">${state.plans.length ? state.plans.map((p) => `<section class="panel plan-card"><div class="plan-card-header"><div class="plan-card-title"><span class="stat-icon mint">${icon("plan")}</span><div><h2>${isAdmin() ? escape(p.customer_name) : escape(p.invoice_number)}</h2><button class="text-button subtle" data-action="invoice" data-id="${p.invoice_id}">${isAdmin() ? escape(p.invoice_number) + " · " : ""}${escape(p.invoice_description)} ${icon("chevron")}</button></div></div>${badge(p.status)}</div><div class="plan-values"><div><span>Proposed monthly payment</span><strong>${money(p.monthly_amount)}<small> / month</small></strong></div><div><span>First payment</span><strong class="date-value">${day(p.start_date)}</strong></div><div><span>Requested</span><strong class="date-value">${day(p.created_at)}</strong></div></div>${p.message ? `<blockquote>“${escape(p.message)}”</blockquote>` : ""}${p.admin_note ? `<div class="admin-response"><strong>Administrator’s response</strong><p>${escape(p.admin_note)}</p></div>` : ""}<div class="plan-card-footer"><span>${p.status === "pending" ? "Awaiting administrator review." : p.status === "approved" ? "Approved. Arrange payments directly with the business." : "You can submit a new proposal from the invoice."}</span>${isAdmin() && p.status === "pending" ? `<button class="button primary" data-action="review-plan" data-id="${p.id}">Review request ${icon("arrow")}</button>` : `<button class="text-button" data-action="invoice" data-id="${p.invoice_id}">View invoice ${icon("arrow")}</button>`}</div></section>`).join("") : `<section class="panel empty-state">${icon("plan")}<h3>No requests yet.</h3><p>${isAdmin() ? "Customer payment plan requests will appear here." : "Open an unpaid invoice to propose a monthly payment that works for you."}</p>${!isAdmin() ? '<button class="button primary" data-view="invoices">Explore invoices ' + icon("arrow") + "</button>" : ""}</section>`}</div><div class="info-note">${icon("help")} A plan request does not change the invoice balance or due date. Payments are arranged directly with the business and recorded by an administrator.</div>`;
}
let returnFocus;
function showModal(title, content, wide = false) {
  returnFocus = document.activeElement;
  modal.innerHTML = `<div class="modal-header"><h2 id="modal-title">${title}</h2><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon("close")}</button></div>${content}`;
  modal.className = wide ? "wide" : "";
  if (!modal.open) modal.showModal();
}
modal.addEventListener("close", () => {
  if (returnFocus?.isConnected) returnFocus.focus();
});
modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    const r = modal.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      modal.close();
  }
});
function formEnd(label, cancel = true) {
  return `<p class="form-error" role="alert"></p><div class="modal-actions">${cancel ? '<button type="button" class="button secondary" data-action="close-modal">Cancel</button>' : ""}<button class="button primary" type="submit">${label} ${icon("arrow")}</button></div>`;
}
async function openInvoice(id) {
  const details = await api(`/invoices/${id}`);
  state.invoice = details;
  const { invoice: i, items, payments, plans } = details;
  const active = plans.find((p) => ["pending", "approved"].includes(p.status));
  showModal(
    "Invoice details",
    `<div class="invoice-detail"><div class="invoice-paper-header"><div><div class="paper-brand"><img src="/brand/office-logo.png" class="invoice-logo" alt="The Office of Yash Sunder Raj logo" width="180" height="75"><span>${escape(state.config.business_name)}</span></div><h3>${escape(i.number)}</h3><p>${escape(i.description)}</p></div>${badge(i.status)}</div><div class="invoice-meta"><div><span>BILLED TO</span><strong>${escape(i.customer_name)}</strong><p>${escape(i.customer_email)}</p></div><div><span>ISSUED</span><strong>${day(i.issued_date)}</strong><span class="due-label">DUE DATE</span><strong>${day(i.due_date)}</strong></div></div><div class="table-scroll"><table class="line-table"><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>${items.map((item) => `<tr><td>${escape(item.description)}</td><td>${item.quantity}</td><td>${money(item.unit_amount)}</td><td>${money(item.quantity * item.unit_amount)}</td></tr>`).join("")}</tbody></table></div><div class="invoice-totals"><div><span>Invoice total</span><strong>${money(i.total)}</strong></div><div><span>Payments received</span><strong>−${money(i.paid)}</strong></div><div class="total-due"><span>Balance due</span><strong>${money(i.balance)}</strong></div></div>${i.notes ? `<div class="invoice-notes"><strong>A note for you</strong><p>${escape(i.notes)}</p></div>` : ""}${payments.length ? `<section class="detail-section"><h3>Payment history</h3>${payments.map((p) => `<div class="payment-row"><span class="payment-check">${icon("check")}</span><div><strong>${escape(p.reference || "Payment received")}</strong><small>${day(p.paid_date)}</small></div><b>${money(p.amount)}</b></div>`).join("")}</section>` : ""}${active ? `<div class="invoice-plan-note">${icon("plan")}<div><strong>${active.status === "pending" ? "Payment plan requested" : "Payment plan approved"}</strong><p>${money(active.monthly_amount)} / month · First payment ${day(active.start_date)}</p>${active.admin_note ? `<p>${escape(active.admin_note)}</p>` : ""}</div></div>` : ""}</div><div class="invoice-dialog-footer"><button class="button secondary" data-action="print-invoice">${icon("print")} Print / Save PDF</button>${i.balance > 0 ? (isAdmin() ? `<button class="button primary" data-action="record-payment" data-id="${i.id}">${icon("plus")} Record payment</button>` : !active ? `<button class="button primary" data-action="request-plan" data-id="${i.id}">${icon("plan")} Request payment plan</button>` : "") : '<span class="paid-message">' + icon("check") + " Paid in full. Thank you.</span>"}</div>`,
    true,
  );
}
function newCustomer() {
  showModal(
    "Add a customer",
    `<form id="customer-form" class="modal-form"><p class="muted">Create their account, then add an invoice. Share the temporary password securely.</p><label>Full name<input name="full_name" autocomplete="name" maxlength="100" placeholder="e.g. Alex Johnson" required></label><label>Email address<input name="email" type="email" autocomplete="off" maxlength="254" placeholder="alex@example.com" required></label><label>Temporary password<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="At least 12 characters"></label><p class="field-hint">They’ll be required to change this at first sign-in. This app does not send invitation emails.</p>${formEnd("Create customer")}</form>`,
  );
}
function itemRow() {
  return `<div class="item-row"><label><span class="sr-only">Charge description</span><input name="item_description" placeholder="Describe the charge" maxlength="200" required></label><label><span class="sr-only">Quantity</span><input name="quantity" type="number" min="1" max="10000" step="1" value="1" required></label><label><span class="sr-only">Unit price in USD</span><input name="unit_amount" type="number" min="0.01" max="1000000" step="0.01" placeholder="0.00" required></label><button type="button" class="icon-button remove-item" data-action="remove-item" aria-label="Remove charge">${icon("close")}</button></div>`;
}
function newInvoice() {
  if (!state.customers.length) {
    toast("Add your first customer before creating an invoice.");
    newCustomer();
    return;
  }
  const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  showModal(
    "Create an invoice",
    `<form id="invoice-form" class="modal-form"><p class="muted">A clear description for every charge. All amounts are in USD.</p><div class="form-grid"><label>Customer<select name="customer_id" required><option value="">Select a customer</option>${state.customers.map((c) => `<option value="${c.id}">${escape(c.full_name)} · ${escape(c.email)}</option>`).join("")}</select></label><label>Due date<input type="date" name="due_date" min="2000-01-01" max="2100-12-31" value="${due}" required></label></div><label>Invoice title<input name="description" maxlength="160" placeholder="e.g. Website design & development" required></label><div class="line-items-editor"><div class="line-items-labels"><span>Individual charges</span><span>Qty</span><span>Unit price ($)</span><span></span></div><div id="invoice-items">${itemRow()}</div><button type="button" class="text-button" data-action="add-item">${icon("plus")} Add a charge</button></div><div class="invoice-form-total"><span>Invoice total</span><strong id="invoice-form-total">$0.00</strong></div><label>Note to customer <span class="optional">(optional)</span><textarea name="notes" maxlength="2000" rows="3" placeholder="Payment instructions, a thank-you, or any helpful details."></textarea></label>${formEnd("Create invoice")}</form>`,
    true,
  );
}
function requestPlan() {
  const i = state.invoice.invoice;
  showModal(
    "A plan that works for you",
    `<form id="plan-form" class="modal-form" data-id="${i.id}"><p class="muted">Propose a monthly amount for ${escape(i.number)}. The administrator will review your request.</p><div class="form-balance"><span>Remaining balance</span><strong>${money(i.balance)}</strong></div><div class="form-grid"><label>Monthly payment ($)<input name="monthly_amount" type="number" min="0.01" max="${(i.balance / 100).toFixed(2)}" step="0.01" placeholder="0.00" required></label><label>First payment date<input name="start_date" type="date" min="${today()}" max="2100-12-31" required></label></div><label>A note for the administrator <span class="optional">(optional)</span><textarea name="message" rows="4" maxlength="2000" placeholder="Let us know what would help, or share a little context."></textarea></label><p class="field-hint">This is a request, not an automatic payment. Your balance and due date stay the same until payments are recorded.</p>${formEnd("Send request")}</form>`,
  );
}
function recordPayment() {
  const i = state.invoice.invoice;
  showModal(
    "Record a payment",
    `<form id="payment-form" class="modal-form" data-id="${i.id}"><p class="muted">Record money already received for ${escape(i.number)}. This does not charge a card or transfer money.</p><div class="form-balance"><span>Remaining balance</span><strong>${money(i.balance)}</strong></div><div class="form-grid"><label>Amount received ($)<input name="amount" type="number" min="0.01" max="${(i.balance / 100).toFixed(2)}" step="0.01" required></label><label>Payment date<input name="paid_date" type="date" min="2000-01-01" max="${today()}" value="${today()}" required></label></div><label>Payment reference <span class="optional">(optional)</span><input name="reference" maxlength="200" placeholder="e.g. Bank transfer #1234"></label>${formEnd("Record payment")}</form>`,
  );
}
function reviewPlan(id) {
  const p = state.plans.find((p) => p.id === Number(id));
  showModal(
    "Review payment plan",
    `<form id="review-form" class="modal-form" data-id="${p.id}"><p class="muted">${escape(p.customer_name)} · ${escape(p.invoice_number)}</p><div class="form-balance"><span>Proposed monthly payment</span><strong>${money(p.monthly_amount)}</strong></div><p>First payment: <strong>${day(p.start_date)}</strong></p>${p.message ? `<blockquote>${escape(p.message)}</blockquote>` : ""}<label>Your decision<select name="status"><option value="approved">Approve this plan</option><option value="declined">Decline this plan</option></select></label><label>Response to the customer <span class="optional">(optional)</span><textarea name="admin_note" rows="4" maxlength="2000" placeholder="Share payment instructions or explain your decision."></textarea></label><p class="field-hint">Approving a plan does not schedule or collect payments. Record payments as they are received.</p>${formEnd("Save response")}</form>`,
  );
}
function passwordForm(required = false) {
  return `<form id="password-form" class="${required ? "" : "modal-form"}"><p class="muted">${required ? "Choose your own password before opening your account." : "Use a unique password with at least 12 characters."}</p><label>Current ${required ? "temporary " : ""}password<input type="password" name="current_password" autocomplete="current-password" required maxlength="128"></label><label>New password<input type="password" name="new_password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label>Confirm new password<input type="password" name="confirm_password" autocomplete="new-password" minlength="12" maxlength="128" required></label>${formEnd(required ? "Set password & continue" : "Update password", !required)}</form>`;
}
function renderPasswordRequired() {
  app.innerHTML = `<main class="password-required"><div class="password-brand">${portalBrand(true)}</div><div class="panel"><h1>Make this account yours.</h1>${passwordForm(true)}<button class="text-button" data-action="logout">Sign out</button></div></main>`;
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view) {
    state.view = button.dataset.view;
    state.filter = "all";
    state.search = "";
    render();
    $("#main-content")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    return;
  }
  if (button.dataset.filter) {
    state.filter = button.dataset.filter;
    const search = state.search;
    render();
    state.search = search;
    return;
  }
  const action = button.dataset.action;
  if (!action) return;
  try {
    if (action.startsWith("demo-")) {
      button.disabled = true;
      await signIn(
        action === "demo-admin" ? "admin@demo.local" : "alex@demo.local",
        action === "demo-admin" ? "DemoAdmin2026!" : "DemoClient2026!",
      );
    }
    if (action === "logout") {
      await api("/logout", {});
      state.user = null;
      modal.close();
      renderLogin();
    }
    if (action === "new-customer") newCustomer();
    if (action === "new-invoice") newInvoice();
    if (action === "invoice") await openInvoice(button.dataset.id);
    if (action === "close-modal") modal.close();
    if (action === "request-plan") requestPlan();
    if (action === "record-payment") recordPayment();
    if (action === "review-plan") reviewPlan(button.dataset.id);
    if (action === "print-invoice") window.print();
    if (action === "add-item") {
      if ($$(".item-row").length >= 50) {
        toast("An invoice can have up to 50 charges.");
        return;
      }
      $("#invoice-items").insertAdjacentHTML("beforeend", itemRow());
      $("#invoice-items").lastElementChild.querySelector("input").focus();
    }
    if (action === "remove-item") {
      if ($$(".item-row").length <= 1) {
        toast("Keep at least one charge on the invoice.");
        return;
      }
      button.closest(".item-row").remove();
      updateTotal();
    }
    if (action === "change-password")
      showModal("Change your password", passwordForm());
    if (action === "reset-password") {
      const c = state.customers.find((c) => c.id === Number(button.dataset.id));
      showModal(
        "Reset customer access",
        `<form id="reset-form" class="modal-form" data-id="${c.id}"><p class="muted">Create a new temporary password for ${escape(c.full_name)}. All their existing sessions will be signed out.</p><label>New temporary password<input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><p class="field-hint">Share this securely. They’ll be required to change it when they sign in.</p>${formEnd("Reset password")}</form>`,
      );
    }
  } catch (error) {
    if (!state.user) {
      const el = $(".form-error");
      if (el) el.textContent = error.message;
    } else toast(error.message);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
});
function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}
function updateTotal() {
  const amount = $$(".item-row").reduce(
    (s, row) =>
      s +
      Math.round(Number($("[name=unit_amount]", row).value || 0) * 100) *
        Number($("[name=quantity]", row).value || 0),
    0,
  );
  $("#invoice-form-total").textContent = money(amount);
}
document.addEventListener("input", (event) => {
  if (event.target.id === "invoice-search") {
    state.search = event.target.value;
    $("#invoice-results").innerHTML = invoiceTable(state.invoices);
  }
  if (event.target.closest(".item-row")) updateTotal();
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const submit = $("[type=submit]", form),
    errorEl = $(".form-error", form),
    values = Object.fromEntries(new FormData(form));
  if (submit.disabled) return;
  submit.disabled = true;
  errorEl.textContent = "";
  try {
    if (form.id === "login-form") {
      await signIn(values.email, values.password);
      return;
    }
    if (form.id === "password-form") {
      if (values.new_password !== values.confirm_password)
        throw new Error("Your new passwords do not match.");
      await api("/change-password", values);
      state.user.must_change_password = false;
      await loadData();
      modal.close();
      render();
      toast("Password updated. You’re all set.");
      return;
    }
    let message = "",
      createdId;
    if (form.id === "customer-form") {
      await api("/customers", values);
      message =
        "Customer account created. Share the temporary password securely.";
    }
    if (form.id === "reset-form") {
      await api(`/customers/${form.dataset.id}/reset-password`, values);
      message = "Access reset. Share the new temporary password securely.";
    }
    if (form.id === "invoice-form") {
      values.customer_id = Number(values.customer_id);
      values.items = $$(".item-row", form).map((row) => ({
        description: $("[name=item_description]", row).value,
        quantity: Number($("[name=quantity]", row).value),
        unit_amount: $("[name=unit_amount]", row).value,
      }));
      const data = await api("/invoices", values);
      createdId = data.id;
      message = "Invoice created and available in the customer’s account.";
    }
    if (form.id === "payment-form") {
      await api(`/invoices/${form.dataset.id}/payments`, values);
      createdId = Number(form.dataset.id);
      message = "Payment recorded. The balance has been updated.";
    }
    if (form.id === "plan-form") {
      await api(`/invoices/${form.dataset.id}/plans`, values);
      message = "Your request has been sent for review.";
    }
    if (form.id === "review-form") {
      await api(`/plans/${form.dataset.id}/review`, values);
      message = "Response saved. Your customer can see it in their account.";
    }
    await loadData();
    modal.close();
    render();
    toast(message);
    if (createdId) await openInvoice(createdId);
  } catch (error) {
    if (errorEl.isConnected) errorEl.textContent = error.message;
  } finally {
    if (submit.isConnected) submit.disabled = false;
  }
});

async function init() {
  try {
    state.config = await api("/config");
    document.title = state.config.business_name;
    try {
      const { user } = await api("/me");
      state.user = user;
    } catch (error) {
      if (error.message !== "Please sign in to continue.") throw error;
    }
    if (state.user && !state.user.must_change_password) await loadData();
    render();
  } catch (error) {
    app.innerHTML = `<main class="startup-error"><div class="panel"><h1>Let’s reconnect.</h1><p>${escape(error.message)}</p><a class="button primary" href="/">Try again</a></div></main>`;
  }
}
init();
