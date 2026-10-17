import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { buildServer } from "../server.js";
import { hashPassword } from "../lib/database.js";
import { makeSchedule } from "../lib/plans.js";

const password = "WorkflowTests2026!";
const today = new Date().toISOString().slice(0, 10);
const future = `${new Date().getUTCFullYear() + 1}-01-31`;
async function fixture(options = {}) {
  const sent = [];
  const app = buildServer({
    databasePath: ":memory:",
    production: false,
    codespacesProxy: false,
    publicOrigin: "https://payments.yashsr.com",
    mail: {
      apiKey: "test-only-key",
      from: "payments@example.com",
      send: async (message, key) => {
        sent.push({ ...message, key });
      },
    },
    ...options,
  });
  const addUser = app.db.prepare(
    "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,?)",
  );
  const hash = hashPassword(password);
  addUser.run("Office Admin", "admin@example.com", hash, "admin");
  const customerId = Number(
    addUser.run("Alex Customer", "alex@example.com", hash, "customer")
      .lastInsertRowid,
  );
  addUser.run("Other Customer", "other@example.com", hash, "customer");
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, body, cookie) {
    const response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              Origin: "https://payments.yashsr.com",
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
  const login = async (email) =>
    (await request("/login", { email, password })).cookie;
  const admin = await login("admin@example.com"),
    customer = await login("alex@example.com"),
    other = await login("other@example.com");
  const invoice = async (price = "250.00", extra = {}) => {
    const result = await request(
      "/invoices",
      {
        customer_id: customerId,
        description: "Itemized purchase",
        due_date: future,
        items: [{ description: "Service", quantity: 1, unit_amount: price }],
        ...extra,
      },
      admin,
    );
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.id;
  };
  return {
    ...app,
    sent,
    request,
    admin,
    customer,
    other,
    invoice,
    details: async (id) =>
      (await request(`/invoices/${id}`, undefined, customer)).data,
    plan: (id, months = 3) =>
      request(
        `/invoices/${id}/plans`,
        { term_months: months, accept_fee: true, start_date: future },
        customer,
      ),
    payment: (id, amount, extra = {}) =>
      request(
        `/invoices/${id}/payments`,
        { amount, paid_date: today, ...extra },
        admin,
      ),
    close: async () => {
      app.server.close();
      await once(app.server, "close");
    },
  };
}

test("plan thresholds are inclusive, after discounts, and full-only restrictions are enforced on the server", async () => {
  const f = await fixture();
  try {
    for (const [price, terms] of [
      ["49.99", []],
      ["50.00", [3]],
      ["249.99", [3]],
      ["250.00", [3, 6]],
    ]) {
      const id = await f.invoice(price);
      const detail = await f.details(id);
      assert.deepEqual(
        detail.plan_options.map((term) => term.months),
        terms,
      );
      if (!terms.includes(6)) assert.equal((await f.plan(id, 6)).status, 400);
    }
    const discounted = await f.invoice("100.00", { discount_amount: "50.01" });
    assert.deepEqual((await f.details(discounted)).plan_options, []);
    const full = await f.invoice("300.00", { payment_policy: "full" });
    assert.deepEqual((await f.details(full)).plan_options, []);
    assert.equal((await f.plan(full)).status, 400);
    assert.equal((await f.payment(full, "25.00")).status, 400);
    assert.equal((await f.payment(full, "300.00")).status, 201);
  } finally {
    await f.close();
  }
});

test("plan requests require explicit fee consent and approval applies exactly one fee with a cent-exact schedule", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice("300.00", { discount_amount: "50.00" });
    assert.equal(
      (
        await f.request(
          `/invoices/${id}/plans`,
          { term_months: 6, start_date: future },
          f.customer,
        )
      ).status,
      400,
    );
    const request = await f.plan(id, 6);
    assert.equal(request.status, 201);
    let detail = await f.details(id);
    assert.equal(detail.invoice.balance, 25000, "a request adds no fee yet");
    assert.equal(
      detail.plans[0].fee_amount,
      1138,
      "4.55% of $250, rounded half up",
    );
    assert.equal((await f.plan(id, 3)).status, 409);
    assert.equal(
      (
        await f.request(
          `/plans/${request.data.id}/review`,
          { status: "approved" },
          f.customer,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          `/plans/${request.data.id}/review`,
          { status: "approved" },
          f.admin,
        )
      ).status,
      200,
    );
    detail = await f.details(id);
    assert.equal(detail.invoice.total, 26138);
    assert.equal(detail.invoice.plan_fee, 1138);
    const schedule = detail.plans[0].installments;
    assert.equal(schedule.length, 6);
    assert.equal(
      schedule.reduce((sum, item) => sum + item.amount, 0),
      26138,
    );
    assert.equal(schedule[0].amount, 4356);
    assert.equal(schedule.at(-1).amount, 4358);
    assert.match(schedule[1].due_date, /-02-28$/);
    assert.match(schedule[2].due_date, /-03-31$/);
    assert.equal(
      (
        await f.request(
          `/plans/${request.data.id}/review`,
          { status: "approved" },
          f.admin,
        )
      ).status,
      409,
    );
    assert.equal(
      (await f.payment(id, "43.56", { tip_amount: "5.00", method: "cash" }))
        .status,
      201,
    );
    detail = await f.details(id);
    assert.equal(detail.invoice.balance, 21782);
    assert.equal(detail.plans[0].installments[0].balance, 0);
    assert.equal(detail.plans[0].installments[1].balance, 4356);
    const receipt = (await f.request("/receipts", undefined, f.customer)).data
      .receipts[0];
    assert.equal(receipt.tip_amount, 500);
    assert.equal(receipt.amount, 4356);
    assert.equal(receipt.plan_fee, 1138);
    assert.equal(receipt.balance_after, 21782);
  } finally {
    await f.close();
  }
});

test("3-month fee is one-time on the full purchase even after partial payments; stale requests cannot be approved", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice("50.00");
    let request = await f.plan(id);
    assert.equal((await f.payment(id, "10.00")).status, 201);
    assert.equal(
      (
        await f.request(
          `/plans/${request.data.id}/review`,
          { status: "approved" },
          f.admin,
        )
      ).status,
      409,
    );
    assert.equal((await f.details(id)).invoice.plan_fee, 0);
    assert.equal(
      (
        await f.request(
          `/plans/${request.data.id}/review`,
          { status: "declined" },
          f.admin,
        )
      ).status,
      200,
    );
    request = await f.plan(id);
    assert.equal((await f.details(id)).plans[0].fee_amount, 113);
    assert.equal(
      (
        await f.request(
          `/plans/${request.data.id}/review`,
          { status: "approved" },
          f.admin,
        )
      ).status,
      200,
    );
    const detail = await f.details(id);
    assert.equal(detail.invoice.total, 5113);
    assert.equal(detail.invoice.balance, 4113);
    assert.equal(detail.plans[0].installments[0].balance, 1371);
    assert.equal((await f.payment(id, "41.13")).status, 201);
    assert.equal((await f.details(id)).invoice.status, "paid");
  } finally {
    await f.close();
  }
});

test("monthly dates preserve the original day, clamp month ends, and allocate rounding to the final installment", () => {
  assert.deepEqual(makeSchedule("2028-01-31", 3, 10001), [
    { sequence: 1, due_date: "2028-01-31", amount: 3333 },
    { sequence: 2, due_date: "2028-02-29", amount: 3333 },
    { sequence: 3, due_date: "2028-03-31", amount: 3335 },
  ]);
  assert.equal(
    makeSchedule("2027-12-31", 6, 60000).at(-1).due_date,
    "2028-05-31",
  );
});

test("customer declarations leave debt unchanged, require attestation, and admin verification issues one private receipt", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice("75.00", { payment_policy: "full" });
    const report = {
      method: "venmo",
      amount: "75.00",
      tip_amount: "5.00",
      reference: "Alex — transaction 123",
      attestation: true,
    };
    assert.equal(
      (await f.request(`/invoices/${id}/payment-reports`, report, f.other))
        .status,
      404,
    );
    assert.equal(
      (
        await f.request(
          `/invoices/${id}/payment-reports`,
          { ...report, attestation: false },
          f.customer,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          `/invoices/${id}/payment-reports`,
          { ...report, amount: "10.00" },
          f.customer,
        )
      ).status,
      400,
    );
    const notice = await f.request(
      `/invoices/${id}/payment-reports`,
      report,
      f.customer,
    );
    assert.equal(notice.status, 201);
    assert.equal((await f.details(id)).invoice.balance, 7500);
    assert.equal(
      (await f.request("/receipts", undefined, f.customer)).data.receipts
        .length,
      0,
    );
    assert.equal(
      (await f.request(`/invoices/${id}/payment-reports`, report, f.customer))
        .status,
      409,
    );
    assert.equal(
      (await f.payment(id, "75.00")).status,
      409,
      "manual recording cannot duplicate a pending notice",
    );
    assert.equal(
      (await f.request("/payment-reports", undefined, f.other)).data.reports
        .length,
      0,
    );
    const route = `/payment-reports/${notice.data.id}/review`;
    const decision = { status: "confirmed", verified: true, paid_date: today };
    assert.equal((await f.request(route, decision, f.customer)).status, 403);
    assert.equal(
      (await f.request(route, { ...decision, verified: false }, f.admin))
        .status,
      400,
    );
    assert.equal((await f.request(route, decision, f.admin)).status, 200);
    assert.equal((await f.request(route, decision, f.admin)).status, 409);
    const detail = await f.details(id);
    assert.equal(detail.invoice.balance, 0);
    assert.equal(detail.invoice.tips_received, 500);
    assert.equal(detail.payments.length, 1);
    const receipts = (await f.request("/receipts", undefined, f.customer)).data
      .receipts;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].amount + receipts[0].tip_amount, 8000);
    assert.equal(receipts[0].payment_id, detail.payments[0].id);
    assert.deepEqual(
      (await f.request("/receipts", undefined, f.other)).data.receipts,
      [],
    );
    assert.equal((await f.request("/receipts")).status, 401);
    assert.equal(
      (await f.request("/email-status", undefined, f.customer)).status,
      403,
    );
    await f.flushEmail();
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[0].recipient, "admin@example.com");
    assert.match(f.sent[0].body, /not verified payment/);
    assert.equal(f.sent[1].recipient, "alex@example.com");
    assert.match(f.sent[1].subject, /Thank you/);
    assert.match(f.sent[1].body, /\$80.00/);
    assert.match(f.sent[1].body, /https:\/\/payments.yashsr.com/);
    await f.flushEmail();
    assert.equal(f.sent.length, 2, "sent mail is not resent");
  } finally {
    await f.close();
  }
});

test("rejected notices preserve debt and allow another attempt; receipts retain the balance at payment time", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice("100.00");
    const report = { method: "zelle", amount: "100.00", attestation: true };
    const notice = await f.request(
      `/invoices/${id}/payment-reports`,
      report,
      f.customer,
    );
    assert.equal(
      (
        await f.request(
          `/payment-reports/${notice.data.id}/review`,
          { status: "rejected", admin_note: "I could not find this transfer." },
          f.admin,
        )
      ).status,
      200,
    );
    assert.equal((await f.details(id)).invoice.balance, 10000);
    assert.equal((await f.payment(id, "25.00")).status, 201);
    assert.equal((await f.payment(id, "75.00")).status, 201);
    const receipts = (await f.request("/receipts", undefined, f.customer)).data
      .receipts;
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].balance_after, 0);
    assert.equal(
      receipts[1].balance_after,
      7500,
      "earlier receipt is an immutable snapshot",
    );
    assert.equal(
      (await f.request(`/invoices/${id}/payment-reports`, report, f.customer))
        .status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("mail failures stay queued without affecting money or receipts, and retry uses the same idempotency key", async () => {
  const attempts = [];
  let shouldFail = true;
  const f = await fixture({
    mail: {
      apiKey: "test-only",
      from: "payments@example.com",
      send: async (message, key) => {
        attempts.push(key);
        if (shouldFail) throw new Error("offline");
      },
    },
  });
  try {
    const id = await f.invoice("50.00");
    assert.equal((await f.payment(id, "50.00")).status, 201);
    await f.flushEmail();
    assert.equal((await f.details(id)).invoice.status, "paid");
    assert.equal(
      (await f.request("/receipts", undefined, f.customer)).data.receipts
        .length,
      1,
    );
    let status = (await f.request("/email-status", undefined, f.admin)).data;
    assert.equal(status.enabled, true);
    assert.equal(status.pending, 1);
    f.db.prepare("UPDATE email_outbox SET next_attempt=0").run();
    shouldFail = false;
    await f.flushEmail();
    status = (await f.request("/email-status", undefined, f.admin)).data;
    assert.equal(status.sent, 1);
    assert.equal(attempts[0], attempts[1]);
  } finally {
    await f.close();
  }
});

test("demo mode never queues or sends mail even when provider settings are present", async () => {
  const f = await fixture({ demo: true });
  try {
    const id = await f.invoice("50.00");
    assert.equal((await f.payment(id, "50.00")).status, 201);
    await f.flushEmail();
    assert.equal(f.sent.length, 0);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get().n,
      0,
    );
    assert.equal(
      (await f.request("/receipts", undefined, f.customer)).data.receipts
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("pending payment notices block new plan requests and fee approval until the payment is reviewed", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice("250.00");
    const plan = await f.plan(id, 6);
    const notice = await f.request(
      `/invoices/${id}/payment-reports`,
      { amount: "250.00", method: "zelle", attestation: true },
      f.customer,
    );
    assert.equal(notice.status, 201);
    assert.equal(
      (
        await f.request(
          `/plans/${plan.data.id}/review`,
          { status: "approved" },
          f.admin,
        )
      ).status,
      409,
    );
    assert.equal((await f.details(id)).invoice.plan_fee, 0);
    assert.equal(
      (
        await f.request(
          `/plans/${plan.data.id}/review`,
          { status: "declined" },
          f.admin,
        )
      ).status,
      200,
    );
    assert.equal((await f.plan(id)).status, 409);
    assert.equal(
      (
        await f.request(
          `/payment-reports/${notice.data.id}/review`,
          { status: "confirmed", verified: true, paid_date: today },
          f.admin,
        )
      ).status,
      200,
    );
    assert.equal((await f.details(id)).invoice.balance, 0);
  } finally {
    await f.close();
  }
});

test("maximum purchase plus a one-time fee can be settled in a single payment", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice("1000000.00");
    const plan = await f.plan(id, 6);
    assert.equal(
      (
        await f.request(
          `/plans/${plan.data.id}/review`,
          { status: "approved" },
          f.admin,
        )
      ).status,
      200,
    );
    assert.equal((await f.details(id)).invoice.balance, 104550000);
    assert.equal((await f.payment(id, "1045500.00")).status, 201);
    assert.equal((await f.details(id)).invoice.balance, 0);
  } finally {
    await f.close();
  }
});

test("the Resend adapter constructs an authenticated text-email request without contacting a live recipient", async () => {
  const originalFetch = globalThis.fetch,
    outgoing = [];
  globalThis.fetch = async (url, options) => {
    if (url === "https://api.resend.com/emails") {
      outgoing.push(options);
      return new Response(JSON.stringify({ id: "fake-provider-id" }), {
        status: 200,
      });
    }
    return originalFetch(url, options);
  };
  let f;
  try {
    f = await fixture({
      mail: { apiKey: "test-only-secret", from: "payments@example.com" },
    });
    const id = await f.invoice("50.00");
    await f.payment(id, "50.00");
    await f.flushEmail();
    assert.equal(outgoing.length, 1);
    const request = outgoing[0],
      body = JSON.parse(request.body);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.Authorization, "Bearer test-only-secret");
    assert.ok(request.headers["Idempotency-Key"]);
    assert.deepEqual(body.to, ["alex@example.com"]);
    assert.equal(body.from, "payments@example.com");
    assert.match(body.subject, /Thank you/);
    assert.match(body.text, /\$50.00/);
  } finally {
    await f?.close();
    globalThis.fetch = originalFetch;
  }
});
