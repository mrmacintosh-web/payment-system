import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { buildServer } from "../server.js";
import { hashPassword } from "../lib/database.js";

const pass = "TestPassword2026!";
const today = new Date().toISOString().slice(0, 10);
const future = new Date(Date.now() + 86400000 * 10).toISOString().slice(0, 10);
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "clearledger-test-"));
  const { server, db } = buildServer({
    databasePath: join(dir, "test.sqlite"),
    production: false,
  });
  db.prepare(
    "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,'admin')",
  ).run("Test Admin", "admin@example.com", hashPassword(pass));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(
    path,
    { body, cookie, origin: requestOrigin = origin } = {},
  ) {
    const res = await fetch(`${origin}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json", Origin: requestOrigin }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      data: await res.json(),
      cookie: res.headers.get("set-cookie")?.split(";")[0],
      headers: res.headers,
    };
  }
  const login = async (address, password = pass) => {
    const res = await request("/login", { body: { email: address, password } });
    assert.equal(res.status, 200);
    return res.cookie;
  };
  const close = async () => {
    server.close();
    await once(server, "close");
    rmSync(dir, { recursive: true, force: true });
  };
  return { server, db, request, login, close, origin };
}

test("complete billing flow: account setup, itemized invoice, partial payment, plan approval, and settlement", async () => {
  const f = await fixture();
  try {
    const admin = await f.login("admin@example.com");
    const create = await f.request("/customers", {
      cookie: admin,
      body: {
        full_name: "Alex Customer",
        email: "Alex@example.com",
        password: pass,
      },
    });
    assert.equal(create.status, 201);
    const customerId = create.data.id;
    const client = await f.login("alex@example.com");
    assert.equal(
      (await f.request("/invoices", { cookie: client })).status,
      403,
      "temporary password blocks invoice access",
    );
    const newPass = "NewCustomerPassword2026!";
    assert.equal(
      (
        await f.request("/change-password", {
          cookie: client,
          body: { current_password: pass, new_password: newPass },
        })
      ).status,
      200,
    );
    const inv = await f.request("/invoices", {
      cookie: admin,
      body: {
        customer_id: customerId,
        description: "Development services",
        due_date: future,
        notes: "Thanks!",
        items: [
          { description: "Design", quantity: 2, unit_amount: "100.25" },
          { description: "Hosting", quantity: 1, unit_amount: "9.99" },
        ],
      },
    });
    assert.equal(inv.status, 201);
    const id = inv.data.id;
    let detail = await f.request(`/invoices/${id}`, { cookie: client });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.invoice.total, 21049);
    assert.equal(detail.data.items.length, 2);
    assert.match(detail.data.invoice.number, /^INV-\d{4}-\d{4}$/);
    assert.equal(
      (
        await f.request(`/invoices/${id}/payments`, {
          cookie: admin,
          body: {
            amount: "10.49",
            paid_date: today,
            reference: "Bank transfer",
          },
        })
      ).status,
      201,
    );
    detail = await f.request(`/invoices/${id}`, { cookie: client });
    assert.equal(detail.data.invoice.balance, 20000);
    assert.equal(detail.data.invoice.status, "partial");
    assert.equal(detail.data.payments.length, 1);
    const plan = await f.request(`/invoices/${id}/plans`, {
      cookie: client,
      body: {
        term_months: 3,
        accept_fee: true,
        start_date: future,
        message: "Three installments, please.",
      },
    });
    assert.equal(plan.status, 201);
    assert.equal(
      (
        await f.request(`/invoices/${id}/plans`, {
          cookie: client,
          body: { term_months: 3, accept_fee: true, start_date: future },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(`/plans/${plan.data.id}/review`, {
          cookie: admin,
          body: {
            status: "approved",
            admin_note: "Approved. Please pay by bank transfer.",
          },
        })
      ).status,
      200,
    );
    const plans = await f.request("/plans", { cookie: client });
    assert.equal(plans.data.plans[0].status, "approved");
    assert.match(plans.data.plans[0].admin_note, /Approved/);
    assert.equal(
      (
        await f.request(`/plans/${plan.data.id}/review`, {
          cookie: admin,
          body: { status: "declined" },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(`/invoices/${id}/payments`, {
          cookie: admin,
          body: { amount: "204.74", paid_date: today },
        })
      ).status,
      201,
    );
    detail = await f.request(`/invoices/${id}`, { cookie: client });
    assert.equal(detail.data.invoice.balance, 0);
    assert.equal(detail.data.invoice.status, "paid");
    assert.equal(
      (
        await f.request(`/invoices/${id}/payments`, {
          cookie: admin,
          body: { amount: "1.00", paid_date: today },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(`/invoices/${id}/plans`, {
          cookie: client,
          body: { monthly_amount: "1.00", start_date: future },
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.request("/logout", { cookie: client, body: {} })).status,
      200,
    );
    assert.equal((await f.request("/me", { cookie: client })).status, 401);
  } finally {
    await f.close();
  }
});

test("customers cannot read another account, create invoices, record payments, review plans, or list customers", async () => {
  const f = await fixture();
  try {
    const admin = await f.login("admin@example.com");
    const add = (address) =>
      Number(
        f.db
          .prepare(
            "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,'customer')",
          )
          .run(address, address, hashPassword(pass)).lastInsertRowid,
      );
    const owner = add("owner@example.com");
    add("other@example.com");
    const client = await f.login("other@example.com");
    const invoice = await f.request("/invoices", {
      cookie: admin,
      body: {
        customer_id: owner,
        description: "Private invoice",
        due_date: future,
        items: [
          {
            description: "Private service",
            quantity: 1,
            unit_amount: "123.45",
          },
        ],
      },
    });
    const id = invoice.data.id;
    assert.equal((await f.request("/invoices")).status, 401);
    assert.deepEqual(
      (await f.request("/invoices", { cookie: client })).data.invoices,
      [],
    );
    assert.equal(
      (await f.request(`/invoices/${id}`, { cookie: client })).status,
      404,
    );
    assert.equal(
      (
        await f.request(`/invoices/${id}/plans`, {
          cookie: client,
          body: { monthly_amount: "10", start_date: future },
        })
      ).status,
      404,
    );
    for (const [path, body] of [
      ["/customers", undefined],
      ["/invoices", {}],
      [`/invoices/${id}/payments`, { amount: "1", paid_date: today }],
      ["/plans/1/review", { status: "approved" }],
      ["/customers/1/reset-password", { password: pass }],
    ]) {
      assert.equal(
        (await f.request(path, { cookie: client, body })).status,
        403,
        path,
      );
    }
    assert.deepEqual(
      (await f.request("/plans", { cookie: client })).data.plans,
      [],
    );
  } finally {
    await f.close();
  }
});

test("validates money, dates and quantities without creating partial invoices", async () => {
  const f = await fixture();
  try {
    const admin = await f.login("admin@example.com");
    const customer = await f.request("/customers", {
      cookie: admin,
      body: {
        full_name: "Customer",
        email: "customer@example.com",
        password: pass,
      },
    });
    const good = {
      customer_id: customer.data.id,
      description: "Invoice",
      due_date: future,
      items: [{ description: "Service", quantity: 1, unit_amount: "10.10" }],
    };
    for (const change of [
      { due_date: "2026-02-30" },
      { customer_id: 1 },
      { items: [] },
      { items: [{ description: "Bad", quantity: 0, unit_amount: "5" }] },
      { items: [{ description: "Bad", quantity: 1.5, unit_amount: "5" }] },
      { items: [{ description: "Bad", quantity: 1, unit_amount: "1.001" }] },
      { items: [{ description: "Bad", quantity: 1, unit_amount: "-10" }] },
      { items: [{ description: "Bad", quantity: 2, unit_amount: "1000000" }] },
    ]) {
      assert.equal(
        (
          await f.request("/invoices", {
            cookie: admin,
            body: { ...good, ...change },
          })
        ).status,
        400,
        JSON.stringify(change),
      );
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM invoices").get().n, 0);
    const invoice = await f.request("/invoices", { cookie: admin, body: good });
    const payment = (body) =>
      f.request(`/invoices/${invoice.data.id}/payments`, {
        cookie: admin,
        body,
      });
    assert.equal(
      (await payment({ amount: "10.11", paid_date: today })).status,
      400,
    );
    assert.equal(
      (await payment({ amount: "1", paid_date: future })).status,
      400,
    );
    assert.equal(
      (await payment({ amount: "0", paid_date: today })).status,
      400,
    );
    assert.equal(
      (await payment({ amount: "0.10", paid_date: today })).status,
      201,
    );
    assert.equal(
      (await f.request(`/invoices/${invoice.data.id}`, { cookie: admin })).data
        .invoice.balance,
      1000,
    );
  } finally {
    await f.close();
  }
});

test("login throttling, CSRF checks, session revocation, and secure headers", async () => {
  const f = await fixture();
  try {
    const admin = await f.login("admin@example.com");
    const me = await f.request("/me", { cookie: admin });
    assert.equal(me.headers.get("cache-control"), "no-store");
    assert.ok(!("password_hash" in me.data.user));
    assert.match(
      me.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.equal(
      (
        await f.request("/customers", {
          cookie: admin,
          origin: "https://attacker.example",
          body: {},
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request("/login", {
          origin: "null",
          body: { email: "admin@example.com", password: pass },
        })
      ).status,
      403,
    );
    const customer = await f.request("/customers", {
      cookie: admin,
      body: {
        full_name: "Customer",
        email: "customer@example.com",
        password: pass,
      },
    });
    const session = await f.login("customer@example.com");
    assert.equal(
      (
        await f.request(`/customers/${customer.data.id}/reset-password`, {
          cookie: admin,
          body: { password: "ResetPassword2026!" },
        })
      ).status,
      200,
    );
    assert.equal((await f.request("/me", { cookie: session })).status, 401);
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await f.request("/login", {
            body: { email: "missing@example.com", password: "bad" },
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await f.request("/login", {
          body: { email: "missing@example.com", password: "bad" },
        })
      ).status,
      429,
    );
  } finally {
    await f.close();
  }
});

test("declined plans can be resubmitted; overdue balances are derived from dates", async () => {
  const f = await fixture();
  try {
    const admin = await f.login("admin@example.com");
    const id = Number(
      f.db
        .prepare(
          "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,'customer')",
        )
        .run("Customer", "customer@example.com", hashPassword(pass))
        .lastInsertRowid,
    );
    const client = await f.login("customer@example.com");
    const invoice = await f.request("/invoices", {
      cookie: admin,
      body: {
        customer_id: id,
        description: "Old invoice",
        due_date: "2020-01-01",
        items: [{ description: "Work", quantity: 1, unit_amount: "100" }],
      },
    });
    assert.equal(
      (await f.request("/invoices", { cookie: client })).data.invoices[0]
        .status,
      "overdue",
    );
    const request = () =>
      f.request(`/invoices/${invoice.data.id}/plans`, {
        cookie: client,
        body: { term_months: 3, accept_fee: true, start_date: future },
      });
    const first = await request();
    assert.equal(first.status, 201);
    assert.equal(
      (
        await f.request(`/plans/${first.data.id}/review`, {
          cookie: admin,
          body: {
            status: "declined",
            admin_note: "Please choose a higher amount.",
          },
        })
      ).status,
      200,
    );
    assert.equal((await request()).status, 201);
    assert.equal(
      (await f.request("/plans", { cookie: client })).data.plans.length,
      2,
    );
  } finally {
    await f.close();
  }
});

test("production rejects demo mode and missing HTTPS origin", () => {
  assert.throws(
    () => buildServer({ production: true, databasePath: ":memory:" }),
    /PUBLIC_ORIGIN/,
  );
  assert.throws(
    () =>
      buildServer({
        production: true,
        publicOrigin: "http://billing.example.com",
        databasePath: ":memory:",
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      buildServer({
        production: true,
        publicOrigin: "https://billing.example.com",
        demo: true,
        databasePath: ":memory:",
      }),
    /Demo mode/,
  );
});

test("SQLite data survives server restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clearledger-persist-")),
    path = join(dir, "billing.sqlite");
  try {
    let instance = buildServer({ databasePath: path, production: false });
    instance.db
      .prepare(
        "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,'admin')",
      )
      .run("Admin", "admin@example.com", hashPassword(pass));
    await new Promise((resolve) =>
      instance.server.listen(0, "127.0.0.1", resolve),
    );
    instance.server.close();
    await once(instance.server, "close");
    instance = buildServer({ databasePath: path, production: false });
    assert.equal(
      instance.db.prepare("SELECT email FROM users").get().email,
      "admin@example.com",
    );
    await new Promise((resolve) =>
      instance.server.listen(0, "127.0.0.1", resolve),
    );
    instance.server.close();
    await once(instance.server, "close");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("administrator bootstrap and live database backups are repeatable and preserve data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clearledger-tools-"));
  const source = join(dir, "source.sqlite"),
    output = join(dir, "backup.sqlite");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const run = (script, args = [], extraEnv = {}) =>
    spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
      cwd: root,
      env: { ...process.env, DATABASE_PATH: source, ...extraEnv },
      encoding: "utf8",
    });
  try {
    const create = run("create-admin.js", ["admin@example.com"], {
      ADMIN_PASSWORD: pass,
    });
    assert.equal(create.status, 0, create.stderr);
    assert.ok(
      !create.stdout.includes(pass),
      "bootstrap never prints the password",
    );
    assert.equal(
      run("create-admin.js", ["admin@example.com"], {
        ADMIN_PASSWORD: "AnotherPassword2026!",
      }).status,
      1,
      "duplicate admin must not be overwritten",
    );
    const sourceDb = new DatabaseSync(source);
    assert.equal(
      sourceDb.prepare("SELECT COUNT(*) AS n FROM users").get().n,
      1,
    );
    sourceDb.exec("PRAGMA journal_mode=WAL");
    sourceDb
      .prepare("UPDATE users SET full_name=?")
      .run("Backed up administrator");
    const result = run("backup.js", [output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      run("backup.js", [output]).status,
      1,
      "existing backups must not be overwritten",
    );
    const restored = new DatabaseSync(output, { readOnly: true });
    assert.equal(
      restored.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.equal(
      restored.prepare("SELECT full_name FROM users").get().full_name,
      "Backed up administrator",
    );
    restored.close();
    sourceDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
