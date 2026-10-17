import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../server.js";
import { hashPassword, invoiceQuery, presentInvoice } from "../lib/database.js";
import { addDays, billingDate } from "../lib/billing-dates.js";

const password = "LateFeeTestPassword2027!";
async function fixture(options = {}) {
  let current = new Date(`${options.day || "2027-01-01"}T17:00:00Z`);
  let failMail = false;
  const sent = [];
  const app = buildServer({
    production: false,
    codespacesProxy: false,
    databasePath: options.databasePath || ":memory:",
    demo: options.demo || false,
    publicOrigin: "https://payments.yashsr.com",
    now: () => current,
    mail: {
      apiKey: "fake-only",
      from: "payments@example.com",
      adminEmail: "office@example.com",
      send: async (message, key) => {
        if (failMail) throw new Error("Test provider unavailable");
        sent.push({ ...message, key });
      },
      ...options.mail,
    },
  });
  if (!app.db.prepare("SELECT id FROM users LIMIT 1").get()) {
    const hash = hashPassword(password);
    const insert = app.db.prepare(
      "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,?)",
    );
    insert.run("Office Admin", "admin@example.com", hash, "admin");
    insert.run("Alex Customer", "alex@example.com", hash, "customer");
    insert.run("Other Customer", "other@example.com", hash, "customer");
  }
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, body, cookie) => {
    const response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : {
              Origin: "https://payments.yashsr.com",
              "Content-Type": "application/json",
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
  };
  const admin = (
    await request("/login", { email: "admin@example.com", password })
  ).cookie;
  const customer = (
    await request("/login", { email: "alex@example.com", password })
  ).cookie;
  const other = (
    await request("/login", { email: "other@example.com", password })
  ).cookie;
  return {
    ...app,
    sent,
    request,
    admin,
    customer,
    other,
    set: (day) => {
      current = new Date(day.includes("T") ? day : `${day}T17:00:00Z`);
    },
    failMail: (value) => {
      failMail = value;
    },
    invoice: async (price = "100.00", extra = {}) => {
      const result = await request(
        "/invoices",
        {
          customer_id: 2,
          description: "Late-fee test purchase",
          due_date: "2027-01-10",
          items: [{ description: "Service", quantity: 1, unit_amount: price }],
          ...extra,
        },
        admin,
      );
      assert.equal(result.status, 201, JSON.stringify(result.data));
      return result.data.id;
    },
    details: async (id) =>
      (await request(`/invoices/${id}`, undefined, customer)).data,
    payment: (id, amount, paid_date, extra = {}) =>
      request(
        `/invoices/${id}/payments`,
        { amount, paid_date, ...extra },
        admin,
      ),
    plan: (id, start_date, term_months = 3) =>
      request(
        `/invoices/${id}/plans`,
        { start_date, term_months, accept_fee: true },
        customer,
      ),
    review: (id, status = "approved") =>
      request(`/plans/${id}/review`, { status }, admin),
    report: (id, amount = "100.00") =>
      request(
        `/invoices/${id}/payment-reports`,
        { amount, method: "zelle", attestation: true },
        customer,
      ),
    close: async () => {
      app.server.close();
      await once(app.server, "close");
    },
  };
}

test("billing uses Eastern calendar days through midnight, DST, month ends, and leap years", () => {
  assert.equal(billingDate(new Date("2027-01-14T04:59:59Z")), "2027-01-13");
  assert.equal(billingDate(new Date("2027-01-14T05:00:00Z")), "2027-01-14");
  assert.equal(billingDate(new Date("2027-07-14T03:59:59Z")), "2027-07-13");
  assert.equal(addDays("2027-03-13", 4), "2027-03-17");
  assert.equal(addDays("2028-02-26", 4), "2028-03-01");
  assert.equal(addDays("2027-12-29", 4), "2028-01-02");
});

test("the running server assesses fees on its minute timer without a customer request", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture();
  try {
    const id = await f.invoice();
    f.set("2027-01-14");
    t.mock.timers.tick(60_000);
    assert.equal(
      f.db
        .prepare("SELECT COUNT(*) n FROM late_fees WHERE invoice_id=?")
        .get(id).n,
      1,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT COUNT(*) n FROM email_outbox WHERE event_key LIKE 'late-fees-%'",
        )
        .get().n,
      2,
    );
  } finally {
    await f.close();
    t.mock.timers.reset();
  }
});

test("first fee is on day four at Eastern midnight, repeats every seven days, and never compounds", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    assert.equal(
      (await f.details(id)).invoice.late_fee_policy,
      "weekly_2_percent",
    );
    f.set("2027-01-14T04:59:59Z");
    assert.equal(f.assessLateFees(), 0);
    f.set("2027-01-14T05:00:00Z");
    assert.equal(f.assessLateFees(), 1);
    assert.equal(f.assessLateFees(), 0);
    let detail = await f.details(id);
    assert.equal(detail.invoice.balance, 10200);
    assert.equal(detail.late_fees[0].assessed_date, "2027-01-14");
    f.set("2027-01-20");
    assert.equal(f.assessLateFees(), 0);
    f.set("2027-01-21");
    assert.equal(f.assessLateFees(), 1);
    detail = await f.details(id);
    assert.equal(detail.invoice.total, 10400);
    assert.deepEqual(
      detail.late_fees.map((fee) => fee.amount),
      [200, 200],
    );
    await f.flushEmail();
    const notices = f.sent.filter((message) =>
      message.subject.startsWith("Late fee charged"),
    );
    assert.equal(notices.length, 2);
    assert.ok(
      notices.every((message) => message.recipient === "alex@example.com"),
    );
    assert.match(notices[0].body, /New late fees: \$2.00/);
    assert.match(notices[0].body, /Current total due: \$102.00/);
    assert.match(notices[0].body, /America\/New_York/);
    assert.match(notices[0].body, /no money has been automatically withdrawn/);
    assert.ok(
      f.sent.some(
        (message) =>
          message.recipient === "office@example.com" &&
          message.subject.startsWith("Late fee added"),
      ),
    );
    assert.ok(
      !f.sent.some((message) => message.recipient === "other@example.com"),
    );
    assert.equal(
      (await f.request(`/invoices/${id}`, undefined, f.other)).status,
      404,
    );
    await f.flushEmail();
    assert.equal(
      f.sent.length,
      5,
      "invoice email and two customer/admin fee notices, once each",
    );
  } finally {
    await f.close();
  }
});

test("fee uses the full discounted purchase, rounds half cents up, excludes tips, and stops when the purchase is paid", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice("250.25", { discount_amount: "150.00" });
    assert.equal(
      (await f.payment(id, "40.00", "2027-01-01", { tip_amount: "99.00" }))
        .status,
      201,
    );
    const fullyDiscounted = await f.invoice("100.00", {
      discount_amount: "100.00",
    });
    const paid = await f.invoice("200.00");
    assert.equal((await f.payment(paid, "200.00", "2027-01-01")).status, 201);
    f.set("2027-01-14");
    assert.equal(f.assessLateFees(), 1);
    let detail = await f.details(id);
    assert.equal(detail.late_fees[0].amount, 201);
    assert.equal(detail.invoice.balance, 6226);
    assert.equal((await f.details(fullyDiscounted)).invoice.balance, 0);
    assert.equal((await f.details(paid)).late_fees.length, 0);
    assert.equal((await f.payment(id, "60.25", "2027-01-14")).status, 201);
    f.set("2027-02-15");
    assert.equal(
      f.assessLateFees(),
      0,
      "late fees alone do not generate additional fees",
    );
    assert.equal((await f.details(id)).invoice.balance, 201);
    assert.equal((await f.payment(id, "2.01", "2027-02-15")).status, 201);
    const receipts = (
      await f.request("/receipts", undefined, f.customer)
    ).data.receipts.filter((receipt) => receipt.invoice_id === id);
    assert.equal(receipts[0].late_fee_total, 201);
    assert.equal(receipts[0].late_fees[0].assessed_date, "2027-01-14");
    assert.equal(receipts[0].balance_after, 0);
    assert.equal(
      receipts.at(-1).late_fee_total,
      0,
      "earlier receipts keep their original snapshot",
    );
  } finally {
    await f.close();
  }
});

test("approved plans use installment grace periods and one weekly invoice fee rather than charging per missed installment", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice("300.00");
    const plan = await f.plan(id, "2027-01-20");
    assert.equal((await f.review(plan.data.id)).status, 200);
    f.set("2027-01-20");
    assert.equal(
      f.assessLateFees(),
      0,
      "old invoice due date is superseded for late fees",
    );
    assert.equal((await f.payment(id, "102.25", "2027-01-20")).status, 201);
    f.set("2027-02-23");
    assert.equal(f.assessLateFees(), 0);
    f.set("2027-02-24");
    assert.equal(f.assessLateFees(), 1);
    let detail = await f.details(id);
    assert.equal(
      detail.late_fees[0].amount,
      600,
      "2% of $300, excluding the plan fee",
    );
    assert.equal(detail.late_fees[0].due_date, "2027-02-20");
    f.set("2027-02-25");
    assert.equal((await f.payment(id, "102.25", "2027-02-25")).status, 201);
    f.set("2027-03-23");
    assert.equal(
      f.assessLateFees(),
      0,
      "catching up the installment stops the overdue streak",
    );
    f.set("2027-03-24");
    assert.equal(f.assessLateFees(), 1);
    detail = await f.details(id);
    assert.equal(detail.late_fees.length, 2);
    assert.equal(detail.invoice.late_fee_total, 1200);
  } finally {
    await f.close();
  }
});

test("plans requested after late fees preserve prior payments and include existing late fees in the quoted schedule", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    assert.equal((await f.payment(id, "20.00", "2027-01-01")).status, 201);
    f.set("2027-01-14");
    f.assessLateFees();
    const plan = await f.plan(id, "2027-01-20");
    assert.equal((await f.review(plan.data.id)).status, 200);
    let detail = await f.details(id);
    assert.equal(detail.plans[0].scheduled_total, 8425);
    assert.equal(detail.plans[0].installments[0].balance, 2808);
    assert.equal((await f.payment(id, "28.08", "2027-01-14")).status, 201);
    detail = await f.details(id);
    assert.equal(detail.plans[0].installments[0].balance, 0);
    assert.equal(detail.plans[0].installments[1].balance, 2808);
  } finally {
    await f.close();
  }
});

test("a late fee changes a pending quote and approval requires a fresh request", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    const plan = await f.plan(id, "2027-01-20");
    f.set("2027-01-14");
    assert.equal((await f.review(plan.data.id)).status, 409);
    assert.equal((await f.details(id)).invoice.plan_fee, 0);
    await f.flushEmail();
    assert.ok(
      !f.sent.some((message) =>
        message.subject.startsWith("Payment plan approved"),
      ),
    );
  } finally {
    await f.close();
  }
});

test("pending payment review pauses fees and timely verified payment avoids charges during the review delay", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    f.set("2027-01-12");
    const report = await f.report(id);
    f.set("2027-02-01");
    assert.equal(f.assessLateFees(), 0);
    assert.equal((await f.details(id)).invoice.balance, 10000);
    assert.equal(
      (
        await f.request(
          `/payment-reports/${report.data.id}/review`,
          { status: "confirmed", verified: true, paid_date: "2027-01-12" },
          f.admin,
        )
      ).status,
      200,
    );
    assert.equal((await f.details(id)).invoice.balance, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM late_fees").get().n, 0);
    await f.flushEmail();
    assert.ok(
      !f.sent.some((message) => message.subject.startsWith("Late fee")),
    );
  } finally {
    await f.close();
  }
});

test("confirmation uses the actual payment date, includes a fee due on that date in the receipt, and adds no fees for the review delay", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    f.set("2027-01-12");
    const report = await f.report(id);
    f.set("2027-02-01");
    assert.equal(
      (
        await f.request(
          `/payment-reports/${report.data.id}/review`,
          { status: "confirmed", verified: true, paid_date: "2027-01-14" },
          f.admin,
        )
      ).status,
      200,
    );
    const detail = await f.details(id);
    assert.equal(detail.late_fees.length, 1);
    assert.equal(detail.invoice.balance, 200);
    const receipts = (await f.request("/receipts", undefined, f.customer)).data
      .receipts;
    assert.equal(receipts[0].balance_after, 200);
    assert.equal(receipts[0].late_fee_total, 200);
  } finally {
    await f.close();
  }
});

test("rejected declarations catch up weekly fees once and group the missed periods into a single customer email", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    f.set("2027-01-12");
    const report = await f.report(id);
    f.set("2027-02-01");
    assert.equal(f.assessLateFees(), 0);
    assert.equal(
      (
        await f.request(
          `/payment-reports/${report.data.id}/review`,
          { status: "rejected", admin_note: "No transfer received." },
          f.admin,
        )
      ).status,
      200,
    );
    assert.equal(f.assessLateFees(), 3);
    assert.equal((await f.details(id)).invoice.balance, 10600);
    assert.equal(f.assessLateFees(), 0);
    await f.flushEmail();
    const notices = f.sent.filter((message) =>
      message.subject.startsWith("Late fee charged"),
    );
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /New late fees: \$6.00/);
    for (const day of ["2027-01-14", "2027-01-21", "2027-01-28"])
      assert.ok(notices[0].body.includes(day));
  } finally {
    await f.close();
  }
});

test("fees and cursor survive restarts and missed weeks catch up without duplicate charges or emails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yash-late-fees-"));
  let f;
  try {
    const databasePath = join(dir, "billing.sqlite");
    f = await fixture({ databasePath });
    const id = await f.invoice();
    f.set("2027-01-14");
    assert.equal(f.assessLateFees(), 1);
    await f.flushEmail();
    await f.close();
    f = await fixture({ databasePath, day: "2027-01-28" });
    assert.equal(
      f.assessLateFees(),
      0,
      "startup already assessed the two missed weeks",
    );
    assert.equal((await f.details(id)).invoice.balance, 10600);
    await f.flushEmail();
    assert.equal(
      f.sent.filter((message) => message.subject.startsWith("Late fee charged"))
        .length,
      1,
    );
    assert.equal((await f.details(id)).late_fees.length, 3);
    assert.equal(
      f.db
        .prepare(
          "SELECT COUNT(*) n FROM email_outbox WHERE event_key LIKE 'late-fees-%'",
        )
        .get().n,
      4,
    );
  } finally {
    await f?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing invoices retain no-fee policy, new invoices may opt out, and invalid options do not create an invoice", async () => {
  const f = await fixture();
  try {
    const old = Number(
      f.db
        .prepare(
          "INSERT INTO invoices(customer_id,number,description,issued_date,due_date) VALUES(2,'OLD-1','Existing purchase','2026-01-01','2026-01-10')",
        )
        .run().lastInsertRowid,
    );
    f.db
      .prepare(
        "INSERT INTO line_items(invoice_id,description,quantity,unit_amount) VALUES(?,'Old service',1,10000)",
      )
      .run(old);
    const exempt = await f.invoice("100.00", { late_fee_enabled: false });
    assert.equal(
      (
        await f.request(
          "/invoices",
          {
            customer_id: 2,
            description: "Invalid option",
            due_date: "2027-01-10",
            items: [
              { description: "Service", quantity: 1, unit_amount: "100" },
            ],
            late_fee_enabled: "true",
          },
          f.admin,
        )
      ).status,
      400,
    );
    f.set("2027-05-01");
    assert.equal(f.assessLateFees(), 0);
    for (const id of [old, exempt]) {
      const detail = await f.details(id);
      assert.equal(detail.invoice.late_fee_policy, "none");
      assert.equal(detail.invoice.balance, 10000);
      assert.equal(detail.late_fees.length, 0);
    }
  } finally {
    await f.close();
  }
});

test("email provider failures keep fees queued, while a failed outbox insert rolls back the assessment atomically", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    f.db.exec(
      "CREATE TRIGGER fail_fee_email BEFORE INSERT ON email_outbox WHEN NEW.event_key LIKE 'late-fees-%' BEGIN SELECT RAISE(ABORT,'Test outbox failure'); END;",
    );
    f.set("2027-01-14");
    assert.throws(() => f.assessLateFees(), /Test outbox failure/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM late_fees").get().n, 0);
    assert.equal(
      presentInvoice(f.db.prepare(`${invoiceQuery} WHERE i.id=?`).get(id))
        .balance,
      10000,
    );
    f.db.exec("DROP TRIGGER fail_fee_email");
    assert.equal(f.assessLateFees(), 1);
    f.failMail(true);
    await f.flushEmail();
    assert.equal((await f.details(id)).invoice.balance, 10200);
    const queued = f.db
      .prepare("SELECT * FROM email_outbox WHERE event_key LIKE 'late-fees-%'")
      .all();
    assert.equal(queued.length, 2);
    assert.ok(
      queued.every(
        (message) => message.status === "pending" && message.attempts === 1,
      ),
    );
    f.failMail(false);
    f.db.prepare("UPDATE email_outbox SET next_attempt=0").run();
    await f.flushEmail();
    assert.equal(
      f.sent.filter((message) => message.subject.startsWith("Late fee charged"))
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("admin can waive an unpaid fee once with an audited reason; customer and unauthorized requests cannot waive it", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    f.set("2027-01-14");
    f.assessLateFees();
    const fee = (await f.details(id)).late_fees[0];
    const route = `/late-fees/${fee.id}/waive`;
    assert.equal(
      (await f.request(route, { note: "Paid on time." })).status,
      401,
    );
    assert.equal(
      (await f.request(route, { note: "Paid on time." }, f.customer)).status,
      403,
    );
    assert.equal((await f.request(route, { note: "" }, f.admin)).status, 400);
    assert.equal(
      (
        await f.request(
          route,
          { note: "Paid on time; recorded late." },
          f.admin,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.request(route, { note: "Again" }, f.admin)).status,
      409,
    );
    const detail = await f.details(id);
    assert.equal(detail.invoice.balance, 10000);
    assert.equal(detail.late_fees[0].waived_by, 1);
    assert.equal(
      detail.late_fees[0].waiver_note,
      "Paid on time; recorded late.",
    );
    assert.equal(f.assessLateFees(), 0);
    await f.flushEmail();
    const notices = f.sent.filter((message) =>
      message.subject.startsWith("Late fee waived"),
    );
    assert.equal(notices.length, 2);
    assert.ok(
      notices.some(
        (message) =>
          message.recipient === "alex@example.com" &&
          message.body.includes("Paid on time; recorded late."),
      ),
    );
    const paid = await f.invoice();
    f.assessLateFees();
    const paidFee = (await f.details(paid)).late_fees[0];
    assert.equal((await f.payment(paid, "102.00", "2027-01-14")).status, 201);
    assert.equal(
      (
        await f.request(
          `/late-fees/${paidFee.id}/waive`,
          { note: "Needs refund" },
          f.admin,
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("waiving a fee incorporated into an approved plan credits final installments without mislabeling credits as payments", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    f.set("2027-01-14");
    f.assessLateFees();
    const fee = (await f.details(id)).late_fees[0];
    const plan = await f.plan(id, "2027-01-20");
    assert.equal((await f.review(plan.data.id)).status, 200);
    const before = (await f.details(id)).plans[0];
    assert.equal(
      (
        await f.request(
          `/late-fees/${fee.id}/waive`,
          { note: "Courtesy waiver" },
          f.admin,
        )
      ).status,
      200,
    );
    const detail = await f.details(id);
    assert.equal(detail.invoice.balance, 10225);
    assert.equal(detail.plans[0].waived_credit, 200);
    assert.equal(
      detail.plans[0].installments.at(-1).balance,
      before.installments.at(-1).balance - 200,
    );
    assert.equal(detail.plans[0].installments.at(-1).paid, 0);
    assert.equal(detail.plans[0].installments.at(-1).credit, 200);
    assert.equal(
      detail.plans[0].installments.reduce((sum, item) => sum + item.balance, 0),
      detail.invoice.balance,
    );
  } finally {
    await f.close();
  }
});

test("large invoices including plan and late fees can still be reported and settled in full", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice("1000000.00");
    const plan = await f.plan(id, "2027-01-10", 6);
    assert.equal((await f.review(plan.data.id)).status, 200);
    f.set("2027-01-14");
    assert.equal(f.assessLateFees(), 1);
    assert.equal((await f.details(id)).invoice.balance, 106550000);
    const report = await f.report(id, "1065500.00");
    assert.equal(report.status, 201);
    assert.equal(
      (
        await f.request(
          `/payment-reports/${report.data.id}/review`,
          { status: "confirmed", verified: true, paid_date: "2027-01-14" },
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

test("demo never assesses fees; missing email settings still allow fees without sending or backfilling notices", async () => {
  for (const options of [{ demo: true }, { mail: { apiKey: "" } }]) {
    const f = await fixture(options);
    try {
      const id = await f.invoice();
      f.set("2027-01-14");
      assert.equal(f.assessLateFees(), options.demo ? 0 : 1);
      assert.equal(
        (await f.details(id)).invoice.balance,
        options.demo ? 10000 : 10200,
      );
      await f.flushEmail();
      assert.equal(f.sent.length, 0);
      assert.equal(
        f.db.prepare("SELECT COUNT(*) n FROM email_outbox").get().n,
        0,
      );
    } finally {
      await f.close();
    }
  }
});
