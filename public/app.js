const $ = (selector, root = document) => root.querySelector(selector);
const app = $("#app"),
  modal = $("#modal");
const state = {
  user: null,
  config: { business_name: "The Office of Yash SR: Payment Portal" },
  invoices: [],
  plans: [],
  customers: [],
  receipts: [],
  reports: [],
  emailStatus: null,
  view: "overview",
  filter: "all",
  search: "",
  invoice: null,
  checkout: null,
  paymentSettings: null,
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
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: state.config.billing_time_zone || "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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
  if (state.config.portal_role && state.config.portal_role !== "login") {
    location.replace(state.config.login_url);
    return;
  }
  app.innerHTML = `<main class="login-layout"><section class="login-story"><div class="login-brand">${portalBrand(true)}</div><div class="story-content"><h1>Your account.<br>All in one place.</h1><p>View your invoices, understand every charge,<br class="desktop-only"> and find a payment plan that works for you.</p><div class="story-features"><span>${icon("invoice")} Itemized invoices</span><span>${icon("plan")} Flexible payment requests</span></div></div></section><section class="login-panel"><div class="login-form-wrap"><h2>Welcome back.</h2><p class="muted login-subtitle">Sign in to view your account.</p><form id="login-form"><label>Email address<input name="email" type="email" autocomplete="username" placeholder="you@example.com" required maxlength="254"></label><label>Password<input name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required maxlength="128"></label><p class="form-error" role="alert">${escape(error)}</p><button class="button primary full" type="submit">Sign in ${icon("arrow")}</button></form><p class="login-help">Need access or a password reset?<br>Contact The Office of Yash SR.</p>${state.config.demo ? `<div class="demo-box"><span class="eyebrow">EXPLORE THE PORTAL</span><p>Try an account with sample information.</p><div class="demo-buttons"><button class="button secondary" data-action="demo-admin">${icon("grid")} Admin demo</button><button class="button secondary" data-action="demo-customer">${icon("settings")} Customer demo</button></div></div>` : ""}<div class="secure-note">${icon("lock")} Your connection is secure</div></div><p class="login-bottom">${escape(state.config.business_name)}</p></section></main>`;
}
async function loadData() {
  const [invoices, plans, customers, receipts, reports, emailStatus] =
    await Promise.all([
      api("/invoices"),
      api("/plans"),
      isAdmin() ? api("/customers") : Promise.resolve({ customers: [] }),
      api("/receipts"),
      api("/payment-reports"),
      isAdmin() ? api("/email-status") : Promise.resolve(null),
    ]);
  state.invoices = invoices.invoices;
  state.plans = plans.plans;
  state.customers = customers.customers;
  state.receipts = receipts.receipts;
  state.reports = reports.reports;
  state.emailStatus = emailStatus;
}
async function signIn(email, password) {
  const { user, redirect_url } = await api("/login", { email, password });
  if (redirect_url) {
    location.assign(redirect_url);
    return;
  }
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
  ["receipts", "invoice", "Receipts"],
  ...(isAdmin() ? [["notices", "mail", "Payment notices"]] : []),
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
  app.innerHTML = `<div class="app-layout ${isAdmin() ? "admin-workspace" : "customer-workspace"}"><header class="site-header"><div class="header-inner">${portalBrand()}<nav class="top-navigation" aria-label="Main navigation">${[...navItems(), ["account", "settings", "Account"]].map(([view, i, label]) => `<button class="nav-item ${state.view === view ? "active" : ""}" data-view="${view}" ${state.view === view ? 'aria-current="page"' : ""}>${icon(i)}<span>${label}</span>${view === "plans" && pending ? `<span class="nav-count" aria-hidden="true">${pending}</span>` : ""}</button>`).join("")}</nav><div class="header-actions">${state.config.demo ? '<span class="demo-pill">Demo</span>' : ""}<button class="avatar profile-button" data-view="account" aria-label="Account settings">${escape(initial(state.user.full_name))}</button><button class="icon-button signout-button" data-action="logout" aria-label="Sign out">${icon("logout")}</button></div></div></header><div class="main-shell"><main id="main-content" tabindex="-1">${renderPage()}</main><footer class="app-footer"><span>${escape(state.config.business_name)}</span><span>${icon("lock")} ${isAdmin() ? "Your account, privately and securely." : "Secure connection"}</span></footer></div></div>`;
}
function heading(eyebrow, title, description, action = "") {
  return `<div class="page-heading"><div>${isAdmin() && eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ""}<h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}
const createButton = () =>
  `<button class="button primary" data-action="new-invoice">${icon("plus")} Create invoice</button>`;
function renderPage() {
  if (state.view === "overview") return overview();
  if (state.view === "invoices")
    return `${heading("KEEP EVERY DETAIL IN SIGHT", "Invoices", isAdmin() ? "Create invoices, track balances, and keep things moving." : "A clear view of what’s due, what’s paid, and everything in between.", isAdmin() ? createButton() : "")}<section class="panel">${invoiceToolbar()}<div id="invoice-results">${invoiceTable(state.invoices)}</div></section><p class="table-footnote">All amounts are in USD. Select an invoice to see its individual charges.</p>`;
  if (state.view === "customers") return customersPage();
  if (state.view === "receipts") return receiptsPage();
  if (state.view === "notices" && isAdmin()) return noticesPage();
  if (state.view === "plans") return plansPage();
  return `${heading("MAKE YOURSELF AT HOME", "Account settings", "Your details and sign-in security.")}<section class="panel account-panel"><div class="profile-large"><span class="avatar">${escape(initial(state.user.full_name))}</span><div><h2>${escape(state.user.full_name)}</h2><p class="muted">${escape(state.user.email)}</p></div></div><dl class="account-details"><div><dt>Account type</dt><dd>${isAdmin() ? "Administrator" : "Customer"}</dd></div><div><dt>Email address</dt><dd>${escape(state.user.email)}</dd></div></dl><div class="account-security"><div><h3>Password & security</h3><p class="muted">Choose a unique password with at least 12 characters.</p></div><button class="button secondary" data-action="change-password">Change password</button></div><div class="account-signout"><button class="text-button" data-action="logout">${icon("logout")} Sign out of your account</button></div></section>${isAdmin() ? `<section class="panel account-panel payment-settings-panel"><div class="info-note">${icon("mail")} ${state.emailStatus?.enabled ? `Email delivery is configured. ${state.emailStatus.pending} queued · ${state.emailStatus.sent} sent.` : state.config.demo ? "Email is disabled in the demo. Receipts and payment notices still appear in the portal." : "Email is not configured. Dashboard receipts and payment notices are available; follow the email setup guide to enable delivery."}</div><span class="eyebrow">HOW CUSTOMERS CAN PAY</span><h2>Payment methods</h2><p class="muted">Add cash instructions, your Venmo username, your Zelle number, and QR codes. You can update these at any time.</p><button class="button secondary" data-action="payment-settings">Manage payment methods ${icon("arrow")}</button></section>` : ""}`;
}
function customerOverview() {
  const outstanding = state.invoices.reduce(
    (sum, invoice) => sum + invoice.balance,
    0,
  );
  const unpaid = state.invoices.filter((invoice) => invoice.balance > 0).length;
  return `<section class="customer-overview"><p class="balance-greeting">Welcome back, ${escape(state.user.full_name.split(" ")[0])}.</p><div class="balance-hero" aria-labelledby="total-due-title"><span class="balance-rule" aria-hidden="true"></span><h1 id="total-due-title">Total due</h1><p class="balance-value ${money(outstanding).length > 10 ? "long-amount" : ""}" aria-label="Total due ${money(outstanding)}">${money(outstanding)}</p><p class="balance-note">${unpaid ? `Across ${unpaid} outstanding invoice${unpaid === 1 ? "" : "s"}. All amounts in USD.` : "You’re all paid up. Thank you."}</p><div class="balance-actions"><button class="button primary" data-view="invoices">View invoices ${icon("arrow")}</button>${unpaid ? `<button class="text-button" data-view="invoices">Request a payment plan ${icon("arrow")}</button>` : ""}${state.receipts.length ? `<button class="text-button" data-view="receipts">View receipts (${state.receipts.length}) ${icon("arrow")}</button>` : ""}</div></div>${
    state.reports.some((report) => report.status === "pending")
      ? `<div class="pending-payment-list">${state.reports
          .filter((report) => report.status === "pending")
          .map(
            (report) =>
              `<div class="info-note">${icon("clock")}<span>${paymentMethodName(report.method)} payment of ${money(report.amount + report.tip_amount)} pending review.</span><button class="text-button" data-action="pay-invoice" data-id="${report.invoice_id}">View payment status ${icon("arrow")}</button></div>`,
          )
          .join("")}</div>`
      : ""
  }</section>`;
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
    (sum, invoice) => sum + invoice.paid + (invoice.tips_received || 0),
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
  return `${state.reports.some((r) => r.status === "pending") ? `<div class="info-note">${icon("mail")} ${state.reports.filter((r) => r.status === "pending").length} payment notice(s) need verification. <button class="text-button" data-view="notices">Review payments ${icon("arrow")}</button></div>` : ""}${heading("ADMINISTRATION", `Welcome back, ${escape(state.user.full_name.split(" ")[0])}.`, "A clear view of your accounts, invoices, and payment requests.", createButton())}<div class="stats-grid">${stats.map(([label, value, note, symbol]) => `<section class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon(symbol)}</span></div><strong>${value}</strong><span class="stat-note">${note}</span></section>`).join("")}</div><div class="overview-grid"><section class="panel recent-panel"><div class="panel-heading"><div><h2>Recent invoices <span class="count-label">${state.invoices.length}</span></h2><p>Choose an invoice to view its charges and payments.</p></div><button class="text-button" data-view="invoices">View all ${icon("arrow")}</button></div>${invoiceTable(state.invoices.slice(0, 5), true)}</section><aside class="overview-aside"><section class="panel side-panel"><div class="panel-heading compact"><h2>Plan requests</h2>${icon("plan")}</div><div class="request-number">${pending.length}<span>awaiting your review</span></div><p class="muted side-copy">Review customer proposals and send a response.</p><button class="button secondary full" data-view="plans">Review requests ${icon("arrow")}</button></section><section class="help-card"><span class="eyebrow">CUSTOMER ACCESS</span><h3>A personal place for every account.</h3><p>Add a customer to give them access to their invoices and payment plans.</p><button class="text-button" data-action="new-customer">Add customer ${icon("plus")}</button></section></aside></div>`;
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
  }</section><div class="info-note">${icon("help")} Customer accounts are created by you. Share their temporary password securely; they’ll choose a new one at first sign-in. When email is configured, customers receive the login address. Share temporary passwords separately.</div>`;
}
function plansPage() {
  return `${heading("A LITTLE ROOM TO BREATHE", isAdmin() ? "Payment plan requests" : "Payment plans", isAdmin() ? "Review a proposal, leave a response, and find a way forward." : "Your requests and responses, all in one place.", !isAdmin() ? '<button class="button primary" data-view="invoices">Find an invoice ' + icon("arrow") + "</button>" : "")}<div class="plan-list">${state.plans.length ? state.plans.map((p) => `<section class="panel plan-card"><div class="plan-card-header"><div class="plan-card-title"><span class="stat-icon mint">${icon("plan")}</span><div><h2>${isAdmin() ? escape(p.customer_name) : escape(p.invoice_number)}</h2><button class="text-button subtle" data-action="invoice" data-id="${p.invoice_id}">${isAdmin() ? escape(p.invoice_number) + " · " : ""}${escape(p.invoice_description)} ${icon("chevron")}</button></div></div>${badge(p.status)}</div><div class="plan-values"><div><span>Proposed monthly payment</span><strong>${money(p.monthly_amount)}<small> / month</small></strong></div><div><span>First payment</span><strong class="date-value">${day(p.start_date)}</strong></div><div><span>Requested</span><strong class="date-value">${day(p.created_at)}</strong></div></div>${planSummary(p)}${p.message ? `<blockquote>“${escape(p.message)}”</blockquote>` : ""}${p.admin_note ? `<div class="admin-response"><strong>Administrator’s response</strong><p>${escape(p.admin_note)}</p></div>` : ""}<div class="plan-card-footer"><span>${p.status === "pending" ? "Awaiting administrator review." : p.status === "approved" ? "Approved. Arrange payments directly with the business." : "You can submit a new proposal from the invoice."}</span>${isAdmin() && p.status === "pending" ? `<button class="button primary" data-action="review-plan" data-id="${p.id}">Review request ${icon("arrow")}</button>` : `<button class="text-button" data-action="invoice" data-id="${p.invoice_id}">View invoice ${icon("arrow")}</button>`}</div></section>`).join("") : `<section class="panel empty-state">${icon("plan")}<h3>No requests yet.</h3><p>${isAdmin() ? "Customer payment plan requests will appear here." : "Open an unpaid invoice to propose a monthly payment that works for you."}</p>${!isAdmin() ? '<button class="button primary" data-view="invoices">Explore invoices ' + icon("arrow") + "</button>" : ""}</section>`}</div><div class="info-note">${icon("help")} Requests await review. Approval adds the disclosed one-time fee and creates the installment schedule. Payments are made directly and confirmed by the administrator; no automatic debits are scheduled.</div>`;
}
let returnFocus;
function showModal(title, content, wide = false) {
  returnFocus = document.activeElement;
  modal.innerHTML = `<div class="modal-header"><h2 id="modal-title">${title}</h2><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon("close")}</button></div>${content}`;
  modal.className = wide ? "wide" : "";
  if (!modal.open) modal.showModal();
  modal.scrollTop = 0;
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
function lateFeeDetails(invoice, fees = []) {
  if (invoice.late_fee_policy !== "weekly_2_percent") return "";
  return `<section class="detail-section late-fee-details"><h3>Late-fee policy</h3><p>After 3 full calendar days overdue, a fee of 2% of the purchase total after discounts is added on day 4 and every 7 days while overdue. Tips, plan fees, and earlier late fees are excluded. Approved payment plans use installment due dates. Fees stop accruing once the purchase and plan fee are paid. Dates follow Eastern Time.</p>${fees.map((fee) => `<div class="payment-row"><div><strong>${fee.waived_at ? "Late fee waived" : "Weekly late fee"}</strong><small>${day(fee.assessed_date)} · Payment due ${day(fee.due_date)}</small>${fee.waived_at ? `<small>${escape(fee.waiver_note)}</small>` : isAdmin() ? `<button class="text-button" data-action="waive-late-fee" data-id="${fee.id}">Waive fee</button>` : ""}</div><b>${fee.waived_at ? "Waived · " : ""}${money(fee.amount)}</b></div>`).join("")}</section>`;
}
function waiveLateFee(id) {
  const fee = state.invoice.late_fees.find((fee) => fee.id === Number(id));
  showModal(
    "Waive late fee",
    `<form id="waive-fee-form" class="modal-form" data-id="${fee.id}"><p>Remove the ${money(fee.amount)} late fee dated ${day(fee.assessed_date)} from ${escape(state.invoice.invoice.number)}. The original charge and your reason remain in the invoice history.</p><label>Reason<textarea name="note" maxlength="2000" required rows="3"></textarea></label>${formEnd("Waive fee")}</form>`,
  );
}
async function openInvoice(id) {
  const details = await api(`/invoices/${id}`);
  state.invoice = details;
  const { invoice: i, items, payments, plans } = details;
  const active = plans.find((p) => ["pending", "approved"].includes(p.status));
  const pendingReport = details.reports?.find((r) => r.status === "pending");
  const canRequest =
    !active &&
    !pendingReport &&
    (i.payment_policy === "legacy" || details.plan_options?.length > 0);
  showModal(
    "Invoice details",
    `<div class="invoice-detail"><div class="invoice-paper-header"><div><div class="paper-brand"><img src="/brand/office-logo.png" class="invoice-logo" alt="The Office of Yash Sunder Raj logo" width="180" height="75"><span>${escape(state.config.business_name)}</span></div><h3>${escape(i.number)}</h3><p>${escape(i.description)}</p></div>${badge(i.status)}</div><div class="invoice-meta"><div><span>BILLED TO</span><strong>${escape(i.customer_name)}</strong><p>${escape(i.customer_email)}</p></div><div><span>ISSUED</span><strong>${day(i.issued_date)}</strong><span class="due-label">DUE DATE</span><strong>${day(i.due_date)}</strong></div></div><div class="table-scroll"><table class="line-table"><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>${items.map((item) => `<tr><td>${escape(item.description)}</td><td>${item.quantity}</td><td>${money(item.unit_amount)}</td><td>${money(item.quantity * item.unit_amount)}</td></tr>`).join("")}</tbody></table></div><div class="invoice-totals">${i.discount_amount > 0 ? `<div><span>Charges subtotal</span><strong>${money(i.subtotal)}</strong></div><div class="discount-row"><span>${escape(i.discount_label || "Sale / discount")}</span><strong>−${money(i.discount_amount)}</strong></div>` : ""}${i.plan_fee > 0 ? `<div><span>Purchase total after discounts</span><strong>${money(i.base_total)}</strong></div><div><span>One-time payment plan fee</span><strong>${money(i.plan_fee)}</strong></div>` : ""}${i.late_fee_total ? `<div><span>Late fees</span><strong>${money(i.late_fee_total)}</strong></div>` : ""}<div><span>Invoice total</span><strong>${money(i.total)}</strong></div><div><span>Applied to invoice</span><strong>−${money(i.paid)}</strong></div><div class="total-due"><span>Balance due</span><strong>${money(i.balance)}</strong></div></div>${lateFeeDetails(i, details.late_fees)}${i.notes ? `<div class="invoice-notes"><strong>A note for you</strong><p>${escape(i.notes)}</p></div>` : ""}${payments.length ? `<section class="detail-section"><h3>Payment history</h3>${payments.map((p) => `<div class="payment-row"><span class="payment-check">${icon("check")}</span><div><strong>${escape(p.reference || "Payment received")}</strong><small>${day(p.paid_date)} · ${paymentMethodName(p.method)}</small>${p.tip_amount > 0 ? `<small>${money(p.amount)} toward invoice · ${money(p.tip_amount)} tip</small>` : ""}</div><b>${money(p.amount + (p.tip_amount || 0))}</b></div>`).join("")}</section>` : ""}${i.payment_policy === "full" ? `<p class="info-note">Payment in full is required for this invoice.</p>` : ""}${pendingReport ? `<p class="info-note">${icon("clock")} Your ${paymentMethodName(pendingReport.method)} payment notice for ${money(pendingReport.amount + pendingReport.tip_amount)} is awaiting verification. Your balance updates after confirmation.</p>` : ""}${
      details.reports?.some((r) => r.status !== "pending")
        ? `<section class="detail-section"><h3>Payment notices</h3>${details.reports
            .filter((r) => r.status !== "pending")
            .map(
              (r) =>
                `<p><strong>${paymentMethodName(r.method)} · ${money(r.amount + r.tip_amount)} · ${r.status === "confirmed" ? "Confirmed" : "Not verified"}</strong>${r.admin_note ? `<br>${escape(r.admin_note)}` : ""}</p>`,
            )
            .join("")}</section>`
        : ""
    }${active ? `<div class="invoice-plan-note">${icon("plan")}<div><strong>${active.status === "pending" ? "Payment plan requested" : "Payment plan approved"}</strong><p>${money(active.monthly_amount)} / month · First payment ${day(active.start_date)}</p>${active.admin_note ? `<p>${escape(active.admin_note)}</p>` : ""}${planSummary(active)}</div></div>` : ""}</div><div class="invoice-dialog-footer"><button class="button secondary" data-action="print-invoice">${icon("print")} Print / Save PDF</button>${i.balance > 0 ? (isAdmin() ? `${pendingReport ? `<button class="button primary" data-action="review-report" data-id="${pendingReport.id}">Verify payment notice</button>` : `<button class="button primary" data-action="record-payment" data-id="${i.id}">${icon("plus")} Record payment</button>`}` : `<div class="invoice-customer-actions">${pendingReport ? `<button class="button secondary" data-action="pay-invoice" data-id="${i.id}">${icon("clock")} View payment status</button>` : `<button class="button primary" data-action="pay-invoice" data-id="${i.id}">Make a payment ${icon("arrow")}</button>`}${canRequest ? `<button class="button secondary" data-action="request-plan" data-id="${i.id}">${icon("plan")} Request payment plan</button>` : ""}</div>`) : '<span class="paid-message">' + icon("check") + " Paid in full. Thank you.</span>"}</div>`,
    true,
  );
}
function newCustomer() {
  showModal(
    "Add a customer",
    `<form id="customer-form" class="modal-form"><p class="muted">Create their account, then add an invoice. Share the temporary password securely.</p><label>Full name<input name="full_name" autocomplete="name" maxlength="100" placeholder="e.g. Alex Johnson" required></label><label>Email address<input name="email" type="email" autocomplete="off" maxlength="254" placeholder="alex@example.com" required></label><label>Temporary password<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="At least 12 characters"></label><p class="field-hint">They’ll be required to change this at first sign-in. When email is configured, they receive the login address. Share their temporary password separately; it is never emailed.</p>${formEnd("Create customer")}</form>`,
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
  const due = new Date(Date.parse(today()) + 14 * 86400000)
    .toISOString()
    .slice(0, 10);
  showModal(
    "Create an invoice",
    `<form id="invoice-form" class="modal-form"><p class="muted">A clear description for every charge. All amounts are in USD.</p><div class="form-grid"><label>Customer<select name="customer_id" required><option value="">Select a customer</option>${state.customers.map((c) => `<option value="${c.id}">${escape(c.full_name)} · ${escape(c.email)}</option>`).join("")}</select></label><label>Due date<input type="date" name="due_date" min="2000-01-01" max="2100-12-31" value="${due}" required></label></div><label>Invoice title<input name="description" maxlength="160" placeholder="e.g. Website design & development" required></label><div class="line-items-editor"><div class="line-items-labels"><span>Individual charges</span><span>Qty</span><span>Unit price ($)</span><span></span></div><div id="invoice-items">${itemRow()}</div><button type="button" class="text-button" data-action="add-item">${icon("plus")} Add a charge</button></div><div class="invoice-discount"><span class="eyebrow">SALE / DISCOUNT</span><div class="form-grid"><label>Discount amount ($)<input name="discount_amount" type="number" min="0" max="1000000" step="0.01" value="0.00"></label><label>Discount label <span class="optional">(optional)</span><input name="discount_label" maxlength="200" placeholder="e.g. Holiday sale"></label></div><p class="field-hint">A dollar amount to subtract from the charges. Leave it at zero for no discount.</p></div><div class="invoice-form-total"><span>Invoice total</span><strong id="invoice-form-total">$0.00</strong></div><label>Payment options<select name="payment_policy"><option value="eligible">Allow eligible 3- or 6-month plans</option><option value="full">Pay in full only</option></select></label><p class="field-hint">$50+ after discounts: 3 months with a one-time 2.25% fee. $250+: also 6 months with a one-time 4.55% fee. Tips are excluded. You review each request.</p><label>Note to customer <span class="optional">(optional)</span><textarea name="notes" maxlength="2000" rows="3" placeholder="Payment instructions, a thank-you, or any helpful details."></textarea></label><label class="check-label"><input type="checkbox" name="late_fee_enabled" checked><span>Apply a weekly late fee of 2% after the 3-day grace period.</span></label><p class="field-hint">The first fee is added on day 4 overdue, then every 7 days while overdue. The fee uses the purchase total after discounts and excludes tips and other fees. Approved plans use installment dates.</p>${formEnd("Create invoice")}</form>`,
    true,
  );
}
function requestPlan() {
  const i = state.invoice.invoice;
  if (i.payment_policy !== "legacy") {
    fixedPlanForm();
    return;
  }
  showModal(
    "A plan that works for you",
    `<form id="plan-form" class="modal-form" data-id="${i.id}"><p class="muted">Propose a monthly amount for ${escape(i.number)}. The administrator will review your request.</p><div class="form-balance"><span>Remaining balance</span><strong>${money(i.balance)}</strong></div><div class="form-grid"><label>Monthly payment ($)<input name="monthly_amount" type="number" min="0.01" max="${(i.balance / 100).toFixed(2)}" step="0.01" placeholder="0.00" required></label><label>First payment date<input name="start_date" type="date" min="${today()}" max="2100-12-31" required></label></div><label>A note for the administrator <span class="optional">(optional)</span><textarea name="message" rows="4" maxlength="2000" placeholder="Let us know what would help, or share a little context."></textarea></label><p class="field-hint">This is a request, not an automatic payment. Your balance and due date stay the same until payments are recorded.</p>${formEnd("Send request")}</form>`,
  );
}
function recordPayment() {
  const i = state.invoice.invoice;
  showModal(
    "Record a payment",
    `<form id="payment-form" class="modal-form" data-id="${i.id}"><p class="muted">Record money already received for ${escape(i.number)}. This does not charge a card or transfer money.</p><div class="form-balance"><span>Remaining balance</span><strong>${money(i.balance)}</strong></div><div class="form-grid"><label>Amount toward invoice ($)<input name="amount" type="number" min="0.01" max="${(i.balance / 100).toFixed(2)}" step="0.01" value="${i.payment_policy === "full" ? (i.balance / 100).toFixed(2) : ""}" ${i.payment_policy === "full" ? "readonly" : ""} required></label><label>Payment date<input name="paid_date" type="date" min="2000-01-01" max="${today()}" value="${today()}" required></label></div><div class="form-grid payment-record-extras"><label>Tip received ($)<input name="tip_amount" type="number" min="0" max="1000000" step="0.01" value="0.00"></label><label>Payment method<select name="method"><option value="other">Other / bank transfer</option><option value="cash">Cash</option><option value="venmo">Venmo</option><option value="zelle">Zelle</option></select></label></div><p class="field-hint">The invoice payment excludes any tip. Record any tip separately. A receipt will appear in the customer’s dashboard after you save.</p><label>Payment reference <span class="optional">(optional)</span><input name="reference" maxlength="200" placeholder="e.g. Bank transfer #1234"></label>${formEnd("Record payment")}</form>`,
  );
}
const paymentMethodName = (method) =>
  ({ cash: "Cash", venmo: "Venmo", zelle: "Zelle", other: "Other" })[method] ||
  "Other";
const qrPreview = (value, method) =>
  value
    ? `<img class="payment-qr" src="${escape(value)}" alt="${paymentMethodName(method)} payment QR code">`
    : `<div class="qr-placeholder">${icon("invoice")}<span>${paymentMethodName(method)} QR code not added yet</span></div>`;

async function openPayment(id) {
  const [details, settings] = await Promise.all([
    api(`/invoices/${id}`),
    api("/payment-settings"),
  ]);
  state.invoice = details;
  if (details.invoice.balance <= 0) {
    toast("This invoice is already paid.");
    await openInvoice(id);
    return;
  }
  const pendingReport = details.reports?.find(
    (report) => report.status === "pending",
  );
  if (pendingReport) {
    showPendingPayment(pendingReport, details.invoice);
    return;
  }
  state.checkout = {
    invoice: details.invoice,
    settings: settings.payment_settings,
    method: "cash",
    amount:
      details.plans
        .find((p) => p.status === "approved")
        ?.installments?.find((item) => item.balance > 0)?.balance ||
      details.invoice.balance,
    flexible: details.plans.some((p) => p.status === "approved"),
  };
  showModal(
    "Make a payment",
    `<div class="payment-flow"><p class="muted">${escape(details.invoice.number)} · ${escape(details.invoice.description)}</p><label>Amount toward invoice ($)<input id="checkout-amount" type="number" min="0.01" max="${(details.invoice.balance / 100).toFixed(2)}" step="0.01" value="${(state.checkout.amount / 100).toFixed(2)}" ${state.checkout.flexible ? "" : "readonly"}></label><p class="field-hint">${state.checkout.flexible ? "Your next installment is prefilled. You can pay more, up to the full remaining balance." : "Pay the full balance, or request an eligible plan from the invoice first."}</p><div class="checkout-amounts"><div><span>Amount toward invoice</span><strong id="checkout-amount-summary">${money(state.checkout.amount)}</strong></div><div><span>Optional tip</span><strong id="checkout-tip-summary">$0.00</strong></div><div class="checkout-total"><span>Total to pay</span><strong id="checkout-total">${money(details.invoice.balance)}</strong></div></div><section class="tip-section"><h3>Add a tip <span class="optional">(optional)</span></h3><div class="tip-presets" aria-label="Tip amount">${[
      ["0.00", "No tip"],
      ["5.00", "+$5"],
      ["10.00", "+$10"],
      ["20.00", "+$20"],
    ]
      .map(
        ([amount, label]) =>
          `<button class="tip-preset ${amount === "0.00" ? "active" : ""}" data-action="tip-preset" data-amount="${amount}" aria-pressed="${amount === "0.00"}">${label}</button>`,
      )
      .join(
        "",
      )}</div><label class="tip-custom">Tip amount ($)<input id="checkout-tip" type="number" min="0" max="1000000" step="0.01" value="0.00"></label></section><section class="payment-method-section"><h3>How would you like to pay?</h3><div class="payment-method-tabs" aria-label="Payment method">${["cash", "venmo", "zelle"].map((method) => `<button class="payment-method ${method === "cash" ? "active" : ""}" data-action="payment-method" data-method="${method}" aria-pressed="${method === "cash"}">${paymentMethodName(method)}</button>`).join("")}</div><div id="payment-instructions" aria-live="polite"></div></section><p class="field-hint">Choosing a method or tip does not send money or mark your invoice paid. Your balance updates after the administrator records the payment.</p><div class="modal-actions"><button class="button secondary" data-action="invoice" data-id="${id}">Back to invoice</button></div></div>`,
    true,
  );
  updateCheckout();
}

function updateCheckout() {
  const checkout = state.checkout,
    input = $("#checkout-tip");
  if (!checkout || !input) return;
  const value = input.value || "0";
  const valid =
    /^\d{1,7}(?:\.\d{1,2})?$/.test(value) &&
    Number(value) >= 0 &&
    Number(value) <= 1000000;
  if (!valid) {
    $("#checkout-total").textContent = "—";
    $("#payment-instructions").innerHTML =
      '<p class="form-error" role="alert">Enter a tip between $0 and $1,000,000 with up to two decimal places.</p>';
    return;
  }
  const tip = Math.round(Number(value) * 100);
  const amountValue = $("#checkout-amount").value;
  const amount = Math.round(Number(amountValue) * 100);
  if (
    !/^\d{1,12}(?:\.\d{1,2})?$/.test(amountValue) ||
    amount <= 0 ||
    amount > checkout.invoice.balance ||
    (!checkout.flexible && amount !== checkout.invoice.balance)
  ) {
    $("#checkout-total").textContent = "—";
    $("#payment-instructions").innerHTML =
      '<p class="form-error">Enter a valid invoice payment amount.</p>';
    return;
  }
  checkout.amount = amount;
  $("#checkout-amount-summary").textContent = money(amount);
  const total = amount + tip;
  $("#checkout-tip-summary").textContent = money(tip);
  $("#checkout-total").textContent = money(total);
  $$(".tip-preset").forEach((button) => {
    const active = Number(button.dataset.amount) === Number(value);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $$(".payment-method").forEach((button) => {
    const active = button.dataset.method === checkout.method;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const settings = checkout.settings,
    method = checkout.method;
  if (method === "cash") {
    $("#payment-instructions").innerHTML =
      `<div class="payment-instruction-card"><span class="eyebrow">CASH PAYMENT</span><h3>Pay ${money(total)} in person.</h3><p>${escape(settings.cash_instructions || "Please arrange an in-person payment with The Office of Yash SR.")}</p><p class="payment-reference">Invoice reference: <strong>${escape(checkout.invoice.number)}</strong></p></div>`;
    return;
  }
  const recipient =
    method === "venmo" ? settings.venmo_username : settings.zelle_number;
  const qr = settings[`${method}_qr`];
  $("#payment-instructions").innerHTML =
    `<div class="payment-instruction-card electronic-payment"><div class="payment-qr-wrap">${qrPreview(qr, method)}</div><div><span class="eyebrow">${paymentMethodName(method).toUpperCase()} PAYMENT</span><h3>${money(total)}</h3><span class="recipient-label">${method === "venmo" ? "Venmo username" : "Zelle phone number / email"}</span><p class="payment-recipient">${recipient ? escape(method === "venmo" ? `@${recipient}` : recipient) : "Payment details will be added soon."}</p><p>${recipient || qr ? "Use your payment app and verify the recipient before sending." : "Please contact The Office of Yash SR for payment details."}</p><p class="payment-reference">Include invoice reference <strong>${escape(checkout.invoice.number)}</strong>.</p></div></div><div class="payment-report-action"><p>Already sent your payment? Tell us so the administrator can verify it.</p><button class="button primary full" data-action="report-payment">I paid with ${paymentMethodName(method)} ${icon("arrow")}</button></div>`;
}

async function paymentSettings() {
  const { payment_settings: settings } = await api("/payment-settings");
  state.paymentSettings = settings;
  showModal(
    "Payment methods",
    `<form id="payment-settings-form" class="modal-form"><p class="muted">These receiving details are shown to signed-in customers. Add your real details and QR codes whenever you’re ready.</p><label>Cash payment instructions<textarea name="cash_instructions" maxlength="1500" rows="3">${escape(settings.cash_instructions)}</textarea></label>${["venmo", "zelle"].map((method) => `<section class="payment-setup-section"><h3>${paymentMethodName(method)}</h3><label>${method === "venmo" ? "Venmo username" : "Zelle phone number or email"}<input name="${method === "venmo" ? "venmo_username" : "zelle_number"}" value="${escape(method === "venmo" ? settings.venmo_username : settings.zelle_number)}" maxlength="120" placeholder="${method === "venmo" ? "Add your Venmo username" : "Add your Zelle phone number or email"}"></label><div id="${method}-qr-preview" class="settings-qr-preview">${qrPreview(settings[`${method}_qr`], method)}</div><label>${paymentMethodName(method)} QR code<input type="file" name="${method}_qr_file" data-qr-method="${method}" accept="image/png,image/jpeg,image/webp"></label><p class="field-hint">PNG, JPEG, or WebP, up to 1 MB. Leave empty to keep the current code.</p><button type="button" class="text-button" data-action="remove-payment-qr" data-method="${method}">Remove ${paymentMethodName(method)} code</button></section>`).join("")}${formEnd("Save payment methods")}</form>`,
    true,
  );
}

function readQrFile(file) {
  if (!file || file.size === 0) return Promise.resolve(undefined);
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 1024 * 1024
  )
    return Promise.reject(
      new Error("Choose a PNG, JPEG, or WebP image up to 1 MB."),
    );
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read this QR image."));
    reader.readAsDataURL(file);
  });
}

function reviewPlan(id) {
  const p = state.plans.find((p) => p.id === Number(id));
  showModal(
    "Review payment plan",
    `<form id="review-form" class="modal-form" data-id="${p.id}"><p class="muted">${escape(p.customer_name)} · ${escape(p.invoice_number)}</p><div class="form-balance"><span>Proposed monthly payment</span><strong>${money(p.monthly_amount)}</strong></div><p>First payment: <strong>${day(p.start_date)}</strong></p>${planSummary(p)}${planSummary(p)}${p.message ? `<blockquote>${escape(p.message)}</blockquote>` : ""}<label>Your decision<select name="status"><option value="approved">Approve this plan</option><option value="declined">Decline this plan</option></select></label><label>Response to the customer <span class="optional">(optional)</span><textarea name="admin_note" rows="4" maxlength="2000" placeholder="Share payment instructions or explain your decision."></textarea></label><p class="field-hint">Approving adds the disclosed one-time fee and installment schedule for a new fixed-term plan. Verify and record each payment as it is received.</p>${formEnd("Save response")}</form>`,
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
      const { redirect_url } = await api("/logout", {});
      if (redirect_url) {
        location.replace(redirect_url);
        return;
      }
      state.user = null;
      modal.close();
      renderLogin();
    }
    if (action === "new-customer") newCustomer();
    if (action === "receipt") openReceipt(button.dataset.id);
    if (action === "review-report") reviewReport(button.dataset.id);
    if (action === "report-payment") reportPayment();
    if (action === "toggle-display") toggleDisplay();
    if (action === "new-invoice") newInvoice();
    if (action === "invoice") await openInvoice(button.dataset.id);
    if (action === "close-modal") modal.close();
    if (action === "request-plan") requestPlan();
    if (action === "record-payment") recordPayment();
    if (action === "waive-late-fee") waiveLateFee(button.dataset.id);
    if (action === "pay-invoice") await openPayment(button.dataset.id);
    if (action === "payment-settings") await paymentSettings();
    if (action === "payment-method") {
      state.checkout.method = button.dataset.method;
      updateCheckout();
    }
    if (action === "tip-preset") {
      $("#checkout-tip").value = button.dataset.amount;
      updateCheckout();
    }
    if (action === "remove-payment-qr") {
      const method = button.dataset.method;
      $("#payment-settings-form").dataset[`${method}Remove`] = "true";
      $(`[name=${method}_qr_file]`).value = "";
      $(`#${method}-qr-preview`).innerHTML = qrPreview("", method);
    }
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
  const discountField = $("[name=discount_amount]");
  const discount = Math.round(Number(discountField.value || 0) * 100);
  discountField.max = (amount / 100).toFixed(2);
  discountField.setCustomValidity(
    discount > amount ? "The discount cannot exceed the charges subtotal." : "",
  );
  $("#invoice-form-total").textContent = money(amount - discount);
}
document.addEventListener("input", (event) => {
  if (event.target.id === "invoice-search") {
    state.search = event.target.value;
    $("#invoice-results").innerHTML = invoiceTable(state.invoices);
  }
  if (
    event.target.closest(".item-row") ||
    event.target.name === "discount_amount"
  )
    updateTotal();
  if (["checkout-tip", "checkout-amount"].includes(event.target.id))
    updateCheckout();
});
document.addEventListener("change", async (event) => {
  if (event.target.name === "term_months") updatePlanQuote();
  if (!event.target.dataset.qrMethod) return;
  const method = event.target.dataset.qrMethod;
  try {
    const image = await readQrFile(event.target.files[0]);
    if (image) $(`#${method}-qr-preview`).innerHTML = qrPreview(image, method);
  } catch (error) {
    event.target.value = "";
    const removed =
      $("#payment-settings-form").dataset[`${method}Remove`] === "true";
    $(`#${method}-qr-preview`).innerHTML = qrPreview(
      removed ? "" : state.paymentSettings?.[`${method}_qr`] || "",
      method,
    );
    toast(error.message);
  }
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
    if (form.id === "payment-settings-form") {
      const body = {
        cash_instructions: values.cash_instructions,
        venmo_username: values.venmo_username,
        zelle_number: values.zelle_number,
      };
      for (const method of ["venmo", "zelle"]) {
        const file = $(`[name=${method}_qr_file]`, form).files[0];
        if (file) body[`${method}_qr`] = await readQrFile(file);
        else if (form.dataset[`${method}Remove`] === "true")
          body[`${method}_qr`] = "";
      }
      await api("/payment-settings", body);
      message =
        "Payment methods saved. Your customers can now see these details.";
    }
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
      values.late_fee_enabled = values.late_fee_enabled === "on";
      values.items = $$(".item-row", form).map((row) => ({
        description: $("[name=item_description]", row).value,
        quantity: Number($("[name=quantity]", row).value),
        unit_amount: $("[name=unit_amount]", row).value,
      }));
      const data = await api("/invoices", values);
      createdId = data.id;
      message = "Invoice created and available in the customer’s account.";
    }
    if (form.id === "waive-fee-form") {
      const result = await api(`/late-fees/${form.dataset.id}/waive`, values);
      createdId = result.invoice_id;
      message = "Late fee waived. The customer’s balance has been updated.";
    }
    if (form.id === "payment-form") {
      await api(`/invoices/${form.dataset.id}/payments`, values);
      createdId = Number(form.dataset.id);
      message =
        "Payment recorded. The balance and customer’s receipt are ready.";
    }
    if (form.id === "report-form") {
      const { report } = await api(
        `/invoices/${form.dataset.id}/payment-reports`,
        {
          ...state.pendingReport,
          reference: values.reference,
          attestation: values.attestation === "on",
        },
      );
      state.reports = [
        report,
        ...state.reports.filter((item) => item.id !== report.id),
      ];
      state.pendingReport = null;
      render();
      showPendingPayment(report, state.checkout.invoice);
      return;
    }
    if (form.id === "report-review-form") {
      await api(`/payment-reports/${form.dataset.id}/review`, {
        ...values,
        verified: values.verified === "on",
      });
      message =
        values.status === "confirmed"
          ? "Payment confirmed. A receipt is in the customer’s dashboard."
          : "Payment notice rejected. The balance has not changed.";
    }
    if (form.id === "plan-form") {
      if (values.term_months) {
        values.term_months = Number(values.term_months);
        values.accept_fee = values.accept_fee === "on";
      }
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

function planSummary(plan) {
  if (!plan.term_months) return "";
  return `<div class="plan-breakdown"><p><strong>${plan.term_months}-month plan</strong> · One-time ${(plan.fee_bps / 100).toFixed(2)}% fee: ${money(plan.fee_amount)}</p><p>Total scheduled: <strong>${money(plan.scheduled_total)}</strong> · ${plan.term_months - 1} × ${money(plan.monthly_amount)}, then ${money(plan.scheduled_total - plan.monthly_amount * (plan.term_months - 1))}.</p>${plan.waived_credit ? `<p>Waived late-fee credit: <strong>${money(plan.waived_credit)}</strong>. Applied to the final installments below.</p>` : ""}${plan.installments?.length ? `<div class="table-scroll"><table><thead><tr><th>Installment</th><th>Due</th><th>Amount</th><th>Remaining</th></tr></thead><tbody>${plan.installments.map((item) => `<tr><td>${item.sequence}</td><td>${day(item.due_date)}</td><td>${money(item.amount)}</td><td>${item.balance ? money(item.balance) : item.credit ? "Settled with credit" : "Paid"}</td></tr>`).join("")}</tbody></table></div>` : ""}</div>`;
}
function fixedPlanForm() {
  const { invoice, plan_options: options } = state.invoice;
  if (!options?.length) {
    toast("Payment plans are not available for this invoice.");
    return;
  }
  showModal(
    "Choose a payment plan",
    `<form id="plan-form" class="modal-form" data-id="${invoice.id}"><p class="muted">${escape(invoice.number)} · Plans require administrator approval. The fee applies once to the full purchase total after discounts, excluding tips.</p><div class="form-balance"><span>Purchase total</span><strong>${money(invoice.base_total)}</strong></div><label>Plan length<select name="term_months">${options.map((option) => `<option value="${option.months}">${option.months} months · ${(option.fee_bps / 100).toFixed(2)}% one-time fee</option>`).join("")}</select></label><div id="plan-quote" aria-live="polite"></div><label>First payment date<input name="start_date" type="date" min="${today()}" max="2100-07-31" value="${today()}" required></label><label class="check-label"><input name="accept_fee" type="checkbox" required><span>I agree to the one-time fee and payment schedule shown above if this plan is approved.</span></label><label>Note to the administrator <span class="optional">(optional)</span><textarea name="message" maxlength="2000" rows="3"></textarea></label><p class="field-hint">No automatic payments are collected. Approval adds the fee to your balance. Invoice due dates stay visible; installment due dates appear on the approved schedule.</p>${formEnd("Request this plan")}</form>`,
  );
  updatePlanQuote();
}
function updatePlanQuote() {
  const months = Number($("[name=term_months]")?.value);
  const option = state.invoice.plan_options.find(
    (item) => item.months === months,
  );
  if (!option) return;
  $("#plan-quote").innerHTML =
    `<div class="plan-breakdown"><p>Current balance: <strong>${money(state.invoice.invoice.balance)}</strong></p><p>One-time fee (${(option.fee_bps / 100).toFixed(2)}% of ${money(state.invoice.invoice.base_total)}): <strong>${money(option.fee_amount)}</strong></p><p>Total with fee: <strong>${money(option.scheduled_total)}</strong></p><p>${months - 1} monthly payments of <strong>${money(option.monthly_amount)}</strong>, then a final payment of <strong>${money(option.final_amount)}</strong>.</p></div>`;
  const consent = $("[name=accept_fee]");
  if (consent) consent.checked = false;
}
function receiptsPage() {
  return `${heading("CONFIRMED PAYMENTS", "Receipts", "A thank-you and a permanent record for each payment confirmed by the administrator.")}<div class="plan-list">${state.receipts.length ? state.receipts.map((receipt) => `<section class="panel receipt-card"><div><span class="eyebrow">RCP-${String(receipt.id).padStart(6, "0")}</span><h2>${money(receipt.amount + receipt.tip_amount)}</h2><p>${escape(receipt.invoice_number)} · ${day(receipt.paid_date)} · ${paymentMethodName(receipt.method)}</p>${isAdmin() ? `<p>${escape(receipt.customer_name)}</p>` : ""}<p class="muted">${receipt.balance_after === 0 ? "Paid in full. Thank you." : `${money(receipt.balance_after)} remaining after this payment.`}</p></div><button class="button secondary" data-action="receipt" data-id="${receipt.id}">View receipt ${icon("arrow")}</button></section>`).join("") : `<section class="panel empty-state">${icon("invoice")}<h3>Your receipts will appear here.</h3><p>Receipts are created after a payment is verified and recorded.</p></section>`}</div>`;
}
function openReceipt(id) {
  const r = state.receipts.find((receipt) => receipt.id === Number(id));
  if (!r) return;
  showModal(
    "Payment receipt",
    `<div class="invoice-detail receipt-paper"><div class="paper-brand"><img class="invoice-logo" src="/brand/office-logo.png" alt="The Office of Yash Sunder Raj logo" width="180" height="75"><span>${escape(r.business_name)}</span></div><h2>Thank you for your payment.</h2><p>Receipt RCP-${String(r.id).padStart(6, "0")} · ${escape(r.invoice_number)}</p><div class="invoice-meta"><div><span>RECEIVED FROM</span><strong>${escape(r.customer_name)}</strong><p>${escape(r.customer_email)}</p></div><div><span>PAYMENT DATE</span><strong>${day(r.paid_date)}</strong><p>${paymentMethodName(r.method)}${r.reference ? ` · ${escape(r.reference)}` : ""}</p></div></div><h3>${escape(r.description)}</h3>${r.late_fees?.length ? `<section class="detail-section"><h3>Late fees included</h3>${r.late_fees.map((fee) => `<p>${day(fee.assessed_date)} · ${money(fee.amount)}</p>`).join("")}</section>` : ""}<div class="table-scroll"><table><thead><tr><th>Charge</th><th>Amount</th></tr></thead><tbody>${r.items.map((item) => `<tr><td>${escape(item.description)} × ${item.quantity}</td><td>${money(item.quantity * item.unit_amount)}</td></tr>`).join("")}</tbody></table></div><div class="invoice-totals">${r.discount_amount ? `<div><span>${escape(r.discount_label || "Discount")}</span><strong>−${money(r.discount_amount)}</strong></div>` : ""}${r.plan_fee ? `<div><span>One-time plan fee</span><strong>${money(r.plan_fee)}</strong></div>` : ""}${r.late_fee_total ? `<div><span>Late fees</span><strong>${money(r.late_fee_total)}</strong></div>` : ""}<div><span>Invoice total</span><strong>${money(r.invoice_total)}</strong></div><div><span>Applied to invoice</span><strong>${money(r.amount)}</strong></div><div><span>Tip</span><strong>${money(r.tip_amount)}</strong></div><div class="total-due"><span>Total received</span><strong>${money(r.amount + r.tip_amount)}</strong></div><div><span>Remaining after this payment</span><strong>${money(r.balance_after)}</strong></div></div><p class="muted">${r.balance_after === 0 ? "This invoice is paid in full." : "This receipt confirms a payment toward your invoice."} Thank you — The Office of Yash SR.</p></div><div class="invoice-dialog-footer"><button class="button secondary" data-action="print-invoice">${icon("print")} Print / Save PDF</button><button class="button primary" data-action="invoice" data-id="${r.invoice_id}">View invoice</button></div>`,
    true,
  );
}
function noticesPage() {
  return `${heading("VERIFY BEFORE CONFIRMING", "Payment notices", "Customers say they have paid. Check your own Venmo or Zelle account before confirming.")}<div class="plan-list">${state.reports.length ? state.reports.map((r) => `<section class="panel receipt-card"><div><h2>${escape(r.customer_name)} · ${money(r.amount + r.tip_amount)}</h2><p>${escape(r.invoice_number)} · ${paymentMethodName(r.method)} · ${day(r.created_at)}</p><p class="muted">${money(r.amount)} toward invoice · ${money(r.tip_amount)} tip</p><p>${escape(r.reference || "No reference provided")}</p><p><strong>${{ pending: "Awaiting verification", confirmed: "Confirmed — receipt issued", rejected: "Rejected — balance unchanged" }[r.status]}</strong></p>${r.admin_note ? `<p>${escape(r.admin_note)}</p>` : ""}</div>${r.status === "pending" ? `<button class="button primary" data-action="review-report" data-id="${r.id}">Verify payment ${icon("arrow")}</button>` : `<button class="button secondary" data-action="invoice" data-id="${r.invoice_id}">View invoice</button>`}</section>`).join("") : `<section class="panel empty-state"><h3>No payment notices yet.</h3><p>Venmo and Zelle notices appear here when a customer clicks “I paid.”</p></section>`}</div>`;
}
function showPendingPayment(report, invoice) {
  showModal(
    "Payment pending review",
    `<section class="payment-pending-content"><span class="payment-pending-symbol">${icon("clock")}</span>${badge("pending")}<h3>Thank you for your payment.</h3><p>Your payment is pending review by an administrator.</p><div class="payment-pending-summary"><span>Reported payment</span><strong>${money(report.amount + report.tip_amount)}</strong><p>${paymentMethodName(report.method)} · ${escape(invoice.number)}</p><small>${money(report.amount)} toward invoice · ${money(report.tip_amount)} tip</small>${report.reference ? `<p class="pending-reference">Reference: ${escape(report.reference)}</p>` : ""}</div><p class="muted">Your balance will update and a receipt will appear in your dashboard after the administrator verifies the payment.</p><div class="modal-actions"><button class="button secondary" data-action="invoice" data-id="${invoice.id}">View invoice</button><button class="button primary" data-action="close-modal">Done ${icon("check")}</button></div></section>`,
  );
}
function reportPayment() {
  const c = state.checkout,
    tip = Math.round(Number($("#checkout-tip").value || 0) * 100);
  state.pendingReport = {
    amount: (c.amount / 100).toFixed(2),
    tip_amount: (tip / 100).toFixed(2),
    method: c.method,
  };
  showModal(
    "Tell us you’ve paid",
    `<form id="report-form" class="modal-form" data-id="${c.invoice.id}"><p>You are reporting <strong>${money(c.amount + tip)}</strong> sent through <strong>${paymentMethodName(c.method)}</strong> for ${escape(c.invoice.number)}.</p><p class="muted">${money(c.amount)} toward the invoice · ${money(tip)} tip. The administrator will check their account before updating your balance and issuing a receipt.</p><label>Payment reference or note <span class="optional">(optional)</span><input name="reference" maxlength="200" placeholder="e.g. transaction reference or sender name"></label><label class="check-label"><input type="checkbox" name="attestation" required><span>I confirm I have actually sent this amount to the business using ${paymentMethodName(c.method)}.</span></label>${formEnd("Send payment notice")}</form>`,
  );
}
function reviewReport(id) {
  const report = state.reports.find((item) => item.id === Number(id));
  if (!report || report.status !== "pending") return;
  showModal(
    "Verify customer payment",
    `<form id="report-review-form" class="modal-form" data-id="${report.id}"><p><strong>${escape(report.customer_name)}</strong> reports sending <strong>${money(report.amount + report.tip_amount)}</strong> through ${paymentMethodName(report.method)}.</p><p>${escape(report.invoice_number)} · ${money(report.amount)} invoice payment · ${money(report.tip_amount)} tip</p><blockquote>${escape(report.reference || "No reference supplied")}</blockquote><label>Decision<select name="status"><option value="confirmed">Confirm received and issue receipt</option><option value="rejected">Reject — payment not verified</option></select></label><label>Payment date<input type="date" name="paid_date" value="${today()}" min="2000-01-01" max="${today()}" required></label><label class="check-label"><input name="verified" type="checkbox"><span>I checked my own ${paymentMethodName(report.method)} account and verified this exact amount was received. Required to confirm.</span></label><label>Response to customer <span class="optional">(optional)</span><textarea name="admin_note" maxlength="2000" rows="3"></textarea></label>${formEnd("Save decision")}</form>`,
  );
}
function setDisplay(mode) {
  const soft = mode !== "dark";
  document.documentElement.dataset.display = soft ? "soft" : "dark";
  const button = $("#display-toggle");
  button.setAttribute("aria-pressed", String(soft));
  button.textContent = `Soft display: ${soft ? "On" : "Off"}`;
  $("meta[name=theme-color]").content = soft ? "#eeeae1" : "#10110f";
}
function toggleDisplay() {
  const mode =
    document.documentElement.dataset.display === "dark" ? "soft" : "dark";
  setDisplay(mode);
  try {
    localStorage.setItem("yash-display", mode);
  } catch {}
}
try {
  setDisplay(localStorage.getItem("yash-display") || "soft");
} catch {
  setDisplay("soft");
}

async function init() {
  try {
    state.config = await api("/config");
    document.title = state.config.business_name;
    try {
      const { user, redirect_url } = await api("/me");
      if (redirect_url) {
        location.replace(redirect_url);
        return;
      }
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
