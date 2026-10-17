import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildServer } from "../server.js";
import {
  hashPassword,
  openDatabase,
  invoiceQuery,
  presentInvoice,
} from "../lib/database.js";
import {
  getPaymentSettings,
  savePaymentSettings,
} from "../lib/payment-settings.js";

const password = "CommerceTest2026!";
const today = new Date().toISOString().slice(0, 10);
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZl8AAAAASUVORK5CYII=";
async function fixture() {
  const { server, db } = buildServer({
    production: false,
    databasePath: ":memory:",
    publicOrigin: "http://billing.test",
    codespacesProxy: false,
  });
  const add = db.prepare(
    "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,?)",
  );
  add.run(
    "Administrator",
    "admin@example.com",
    hashPassword(password),
    "admin",
  );
  const customerId = Number(
    add.run(
      "Customer",
      "customer@example.com",
      hashPassword(password),
      "customer",
    ).lastInsertRowid,
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, cookie) {
    const response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              Origin: "http://billing.test",
            }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  const admin = (
    await request("/login", { email: "admin@example.com", password })
  ).cookie;
  const customer = (
    await request("/login", { email: "customer@example.com", password })
  ).cookie;
  const createInvoice = (extra = {}) =>
    request(
      "/invoices",
      {
        customer_id: customerId,
        description: "Services",
        due_date: today,
        items: [{ description: "Service", quantity: 1, unit_amount: "100.00" }],
        ...extra,
      },
      admin,
    );
  return {
    db,
    admin,
    customer,
    request,
    createInvoice,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

test("a dollar discount subtracts from itemized charges, customer totals, and payment limits", async () => {
  const f = await fixture();
  try {
    const created = await f.createInvoice({
      discount_amount: "10.49",
      discount_label: "Holiday sale",
      items: [
        { description: "Design", quantity: 2, unit_amount: "100.25" },
        { description: "Hosting", quantity: 1, unit_amount: "9.99" },
      ],
    });
    assert.equal(created.status, 201);
    const id = created.data.id;
    const details = await f.request(`/invoices/${id}`, undefined, f.customer);
    assert.equal(details.data.invoice.subtotal, 21049);
    assert.equal(details.data.invoice.discount_amount, 1049);
    assert.equal(details.data.invoice.discount_label, "Holiday sale");
    assert.equal(details.data.invoice.total, 20000);
    assert.equal(details.data.invoice.balance, 20000);
    assert.equal(
      (await f.request("/invoices", undefined, f.customer)).data.invoices[0]
        .balance,
      20000,
    );
    assert.equal(
      (
        await f.request(
          `/invoices/${id}/payments`,
          { amount: "200.01", paid_date: today },
          f.admin,
        )
      ).status,
      400,
    );
    assert.equal(
      (await f.request("/invoices", { discount_amount: "10" }, f.customer))
        .status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("discount validation prevents negative invoices and a full discount settles the invoice without a payment", async () => {
  const f = await fixture();
  try {
    for (const discount_amount of ["100.01", "-1", "0.001", 12, "not money"]) {
      assert.equal((await f.createInvoice({ discount_amount })).status, 400);
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n, 0);
    const created = await f.createInvoice({ discount_amount: "100.00" });
    assert.equal(created.status, 201);
    const details = await f.request(
      `/invoices/${created.data.id}`,
      undefined,
      f.customer,
    );
    assert.equal(details.data.invoice.balance, 0);
    assert.equal(details.data.invoice.status, "paid");
    assert.equal(details.data.payments.length, 0);
    const zero = await f.createInvoice({ discount_amount: "0.00" });
    assert.equal(zero.status, 201);
  } finally {
    await f.close();
  }
});

test("tips and payment methods are recorded separately and never reduce invoice debt", async () => {
  const f = await fixture();
  try {
    const {
      data: { id },
    } = await f.createInvoice({ discount_amount: "20" });
    let result = await f.request(
      `/invoices/${id}/payments`,
      { amount: "20", tip_amount: "10", method: "venmo", paid_date: today },
      f.admin,
    );
    assert.equal(result.status, 201);
    let details = (await f.request(`/invoices/${id}`, undefined, f.customer))
      .data;
    assert.equal(details.invoice.total, 8000);
    assert.equal(details.invoice.paid, 2000);
    assert.equal(details.invoice.balance, 6000);
    assert.equal(details.invoice.tips_received, 1000);
    assert.equal(details.payments[0].method, "venmo");
    assert.equal(details.payments[0].tip_amount, 1000);
    for (const change of [
      { tip_amount: "-1" },
      { tip_amount: "0.001" },
      { tip_amount: "1000000.01" },
      { method: "pretend" },
      { amount: "60.01" },
    ]) {
      result = await f.request(
        `/invoices/${id}/payments`,
        {
          amount: "10",
          tip_amount: "0",
          method: "cash",
          paid_date: today,
          ...change,
        },
        f.admin,
      );
      assert.equal(result.status, 400);
    }
    assert.equal(
      (
        await f.request(
          `/invoices/${id}/payments`,
          { amount: "60", tip_amount: "10", method: "zelle", paid_date: today },
          f.customer,
        )
      ).status,
      403,
    );
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM payments").get().n, 1);
    assert.equal(
      (
        await f.request(
          `/invoices/${id}/payments`,
          { amount: "60", tip_amount: "10", method: "cash", paid_date: today },
          f.admin,
        )
      ).status,
      201,
    );
    details = (await f.request(`/invoices/${id}`, undefined, f.customer)).data;
    assert.equal(details.invoice.balance, 0);
    assert.equal(details.invoice.status, "paid");
    assert.equal(details.invoice.tips_received, 2000);
    assert.equal(
      details.payments.reduce(
        (sum, payment) => sum + payment.amount + payment.tip_amount,
        0,
      ),
      10000,
    );
  } finally {
    await f.close();
  }
});

test("payment details default to unconfigured, require login, and can only be changed by the administrator", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/payment-settings")).status, 401);
    const defaults = (
      await f.request("/payment-settings", undefined, f.customer)
    ).data.payment_settings;
    assert.equal(defaults.venmo_username, "");
    assert.equal(defaults.venmo_qr, "");
    assert.equal(defaults.zelle_number, "");
    assert.equal(defaults.zelle_qr, "");
    assert.equal(
      (
        await f.request(
          "/payment-settings",
          { venmo_username: "attacker" },
          f.customer,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          "/payment-settings",
          {
            venmo_username: "@OfficeTest",
            zelle_number: "+1 (555) 010-4242",
            venmo_qr: png,
            zelle_qr: png,
            cash_instructions: "Pay in person by appointment.",
          },
          f.admin,
        )
      ).status,
      200,
    );
    const saved = (await f.request("/payment-settings", undefined, f.customer))
      .data.payment_settings;
    assert.equal(saved.venmo_username, "OfficeTest");
    assert.equal(saved.venmo_qr, png);
    assert.equal(saved.zelle_number, "+1 (555) 010-4242");
    assert.equal(saved.zelle_qr, png);
    const largeImage =
      "data:image/png;base64," +
      readFileSync(
        new URL("../public/brand/office-logo.png", import.meta.url),
      ).toString("base64");
    assert.ok(largeImage.length > 32768);
    assert.equal(
      (await f.request("/payment-settings", { venmo_qr: largeImage }, f.admin))
        .status,
      200,
      "a real PNG larger than the normal API body limit can be uploaded",
    );
    assert.equal(
      (await f.request("/payment-settings", { venmo_qr: png }, f.admin)).status,
      200,
    );
    assert.equal(
      (await f.request("/config")).data.payment_settings,
      undefined,
      "receiving details are not exposed on the public login configuration",
    );
    await f.request(
      "/payment-settings",
      { cash_instructions: "New instructions." },
      f.admin,
    );
    assert.equal(
      (await f.request("/payment-settings", undefined, f.customer)).data
        .payment_settings.venmo_qr,
      png,
      "omitting an image preserves it",
    );
    await f.request("/payment-settings", { venmo_qr: "" }, f.admin);
    assert.equal(
      (await f.request("/payment-settings", undefined, f.customer)).data
        .payment_settings.venmo_qr,
      "",
      "an explicit removal clears it",
    );
  } finally {
    await f.close();
  }
});

test("QR uploads reject scripts, external URLs, wrong image types, invalid recipients, and oversized files atomically", async () => {
  const f = await fixture();
  try {
    const oversized =
      "data:image/png;base64," +
      Buffer.alloc(1024 * 1024 + 1).toString("base64");
    for (const change of [
      { venmo_qr: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
      { zelle_qr: "https://example.com/code.png" },
      { venmo_qr: "data:image/png;base64,SGVsbG8=" },
      { zelle_qr: oversized },
      { venmo_username: "https://venmo.com/name" },
      { zelle_number: "-------" },
    ]) {
      const response = await f.request(
        "/payment-settings",
        { cash_instructions: "Must not be saved.", ...change },
        f.admin,
      );
      assert.equal(response.status, 400);
      assert.notEqual(
        (await f.request("/payment-settings", undefined, f.admin)).data
          .payment_settings.cash_instructions,
        "Must not be saved.",
      );
    }
  } finally {
    await f.close();
  }
});

test("legacy databases upgrade repeatedly without changing debts, history, or saved receiving details", () => {
  const dir = mkdtempSync(join(tmpdir(), "office-legacy-")),
    path = join(dir, "billing.sqlite");
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE users(id INTEGER PRIMARY KEY,full_name TEXT,email TEXT,password_hash TEXT,role TEXT,must_change_password INTEGER DEFAULT 0,created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE invoices(id INTEGER PRIMARY KEY,customer_id INTEGER,number TEXT,description TEXT,issued_date TEXT,due_date TEXT,notes TEXT DEFAULT '',created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE line_items(id INTEGER PRIMARY KEY,invoice_id INTEGER,description TEXT,quantity INTEGER,unit_amount INTEGER);
      CREATE TABLE payments(id INTEGER PRIMARY KEY,invoice_id INTEGER,amount INTEGER,paid_date TEXT,reference TEXT,recorded_by INTEGER,created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO users(id,full_name,email,password_hash,role) VALUES(1,'Legacy Customer','legacy@example.com','preserved-hash','customer');
      INSERT INTO invoices(id,customer_id,number,description,issued_date,due_date) VALUES(1,1,'OLD-0001','Legacy services','2026-01-01','2026-02-01');
      INSERT INTO line_items VALUES(1,1,'Services',1,20000);
      INSERT INTO payments(id,invoice_id,amount,paid_date,reference,recorded_by) VALUES(1,1,5000,'2026-01-02','Legacy transfer',1);
    `);
    db.close();
    db = undefined;
    for (let run = 0; run < 2; run++) {
      db = openDatabase(path);
      const invoice = presentInvoice(
        db.prepare(`${invoiceQuery} WHERE i.id=1`).get(),
      );
      assert.equal(invoice.total, 20000);
      assert.equal(invoice.balance, 15000);
      assert.equal(invoice.discount_amount, 0);
      assert.equal(invoice.payment_policy, "legacy");
      assert.equal(invoice.plan_fee, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 0);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get().n,
        0,
      );
      const payment = db.prepare("SELECT * FROM payments WHERE id=1").get();
      assert.equal(payment.amount, 5000);
      assert.equal(payment.tip_amount, 0);
      assert.equal(payment.method, "other");
      assert.equal(
        db.prepare("SELECT password_hash FROM users WHERE id=1").get()
          .password_hash,
        "preserved-hash",
      );
      if (run === 0)
        savePaymentSettings(db, {
          venmo_username: "PreservedAccount",
          venmo_qr: png,
        });
      assert.equal(getPaymentSettings(db).venmo_username, "PreservedAccount");
      assert.equal(getPaymentSettings(db).venmo_qr, png);
      db.close();
      db = undefined;
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
