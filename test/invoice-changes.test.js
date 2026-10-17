import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../server.js";
import { hashPassword } from "../lib/database.js";

const password = "InvoiceChangesTest2027!";
async function fixture(options = {}) {
  let current = new Date("2027-01-01T17:00:00Z");
  const sent = [];
  const app = buildServer({
    databasePath: options.databasePath || ":memory:",
    production: false,
    codespacesProxy: false,
    demo: options.demo || false,
    publicOrigin: "https://payments.yashsr.com",
    now: () => current,
    mail: {
      apiKey: "fake-only",
      from: "payments@example.com",
      adminEmail: "office@example.com",
      send: async (message) => sent.push(message),
      ...options.mail,
    },
  });
  if (!app.db.prepare("SELECT id FROM users LIMIT 1").get()) {
    const hash = hashPassword(password),
      insert = app.db.prepare(
        "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,?)",
      );
    insert.run("Office Admin", "admin@example.com", hash, "admin");
    insert.run("Alex Customer", "alex@example.com", hash, "customer");
    insert.run("Other Customer", "other@example.com", hash, "customer");
  }
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (
    path,
    body,
    cookie,
    origin = "https://payments.yashsr.com",
  ) => {
    const response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json", Origin: origin }),
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
  const details = async (id) =>
    (await request(`/invoices/${id}`, undefined, admin)).data;
  const fields = async (id, extra = {}) => {
    const d = await details(id),
      i = d.invoice;
    return {
      customer_id: i.customer_id,
      revision: i.revision,
      description: i.description,
      due_date: i.due_date,
      notes: i.notes,
      discount_amount: (i.discount_amount / 100).toFixed(2),
      discount_label: i.discount_label,
      payment_policy: i.payment_policy,
      late_fee_enabled: i.late_fee_policy === "weekly_2_percent",
      items: d.items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unit_amount: (item.unit_amount / 100).toFixed(2),
      })),
      reason: "Corrected invoice details.",
      ...extra,
    };
  };
  return {
    ...app,
    sent,
    request,
    admin,
    customer,
    other,
    details,
    fields,
    set: (day) => {
      current = new Date(`${day}T17:00:00Z`);
    },
    invoice: async (price = "100.00", extra = {}) => {
      const result = await request(
        "/invoices",
        {
          customer_id: 2,
          description: "Original invoice",
          due_date: "2027-01-10",
          late_fee_enabled: false,
          items: [
            {
              description: "Original service",
              quantity: 1,
              unit_amount: price,
            },
          ],
          ...extra,
        },
        admin,
      );
      assert.equal(result.status, 201, JSON.stringify(result.data));
      return result.data.id;
    },
    amend: async (id, extra = {}) =>
      request(`/invoices/${id}/amend`, await fields(id, extra), admin),
    remove: async (id) => {
      const i = (await details(id)).invoice;
      return request(
        `/invoices/${id}/delete`,
        {
          revision: i.revision,
          confirm_number: i.number,
          reason: "Invoice created in error.",
        },
        admin,
      );
    },
    payment: (id, amount, tip_amount = "0.00") =>
      request(
        `/invoices/${id}/payments`,
        { amount, tip_amount, paid_date: "2027-01-01" },
        admin,
      ),
    plan: (id) =>
      request(
        `/invoices/${id}/plans`,
        { term_months: 3, start_date: "2027-01-20", accept_fee: true },
        customer,
      ),
    close: async () => {
      app.server.close();
      await once(app.server, "close");
    },
  };
}

test("amendment updates itemized charges, discount, due date and notes, with an audited revision and customer email", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    assert.equal(
      (
        await f.amend(id, {
          description: "Corrected invoice",
          due_date: "2027-02-10",
          notes: "Updated scope.",
          discount_amount: "25.00",
          discount_label: "Correction",
          items: [
            {
              description: "Revised service",
              quantity: 2,
              unit_amount: "75.00",
            },
          ],
          reason: "The original quantity was incorrect.",
        })
      ).status,
      200,
    );
    const d = (await f.request(`/invoices/${id}`, undefined, f.customer)).data;
    assert.equal(d.invoice.total, 12500);
    assert.equal(d.invoice.balance, 12500);
    assert.equal(d.invoice.revision, 2);
    assert.equal(d.invoice.description, "Corrected invoice");
    assert.equal(d.invoice.due_date, "2027-02-10");
    assert.equal(d.invoice.notes, "Updated scope.");
    assert.equal(d.items[0].quantity, 2);
    assert.equal(d.changes[0].reason, "The original quantity was incorrect.");
    assert.equal(
      d.changes[0].before_snapshot,
      undefined,
      "customer gets history without admin snapshots",
    );
    const audit = (await f.details(id)).changes[0];
    assert.equal(JSON.parse(audit.before_snapshot).items[0].unit_amount, 10000);
    assert.equal(JSON.parse(audit.after_snapshot).items[0].quantity, 2);
    await f.flushEmail();
    assert.equal(f.sent.length, 1, "the stale ready email was superseded");
    assert.equal(f.sent[0].recipient, "alex@example.com");
    assert.match(f.sent[0].subject, /Your invoice has been amended/);
    assert.match(f.sent[0].body, /Previous invoice total: \$100.00/);
    assert.match(f.sent[0].body, /Current total due: \$125.00/);
    assert.match(f.sent[0].body, /The original quantity was incorrect/);
    assert.match(f.sent[0].body, /2027-02-10/);
    await f.flushEmail();
    assert.equal(f.sent.length, 1);
  } finally {
    await f.close();
  }
});

test("deletion removes customer access, balances and plan lists, stops late fees, and retains an admin archive", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice("100.00", { late_fee_enabled: true });
    const plan = await f.plan(id);
    assert.equal(plan.status, 201);
    assert.equal((await f.remove(id)).status, 200);
    assert.equal(
      (await f.request("/invoices", undefined, f.customer)).data.invoices
        .length,
      0,
    );
    assert.equal(
      (await f.request("/plans", undefined, f.customer)).data.plans.length,
      0,
    );
    assert.equal(
      (await f.request(`/invoices/${id}`, undefined, f.customer)).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          `/invoices/${id}/plans`,
          { term_months: 3, start_date: "2027-01-20", accept_fee: true },
          f.customer,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          `/invoices/${id}/payment-reports`,
          { method: "zelle", amount: "100.00", attestation: true },
          f.customer,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.request("/invoices?include_deleted=true", undefined, f.customer))
        .status,
      403,
    );
    assert.equal(
      (await f.request("/invoices", undefined, f.admin)).data.invoices.length,
      0,
    );
    const archived = (
      await f.request("/invoices?include_deleted=true", undefined, f.admin)
    ).data.invoices;
    assert.equal(archived.length, 1);
    assert.equal(archived[0].status, "deleted");
    assert.equal(
      (await f.details(id)).invoice.deletion_reason,
      "Invoice created in error.",
    );
    assert.ok(
      f.db
        .prepare("SELECT invalidated_at FROM plan_requests WHERE id=?")
        .get(plan.data.id).invalidated_at,
    );
    f.set("2027-03-01");
    assert.equal(f.assessLateFees(), 0);
    assert.equal((await f.payment(id, "100.00")).status, 404);
    await f.flushEmail();
    assert.equal(
      f.sent.length,
      1,
      "superseded ready and plan notices do not get sent",
    );
    assert.match(f.sent[0].subject, /Your invoice has been removed/);
    assert.equal(f.sent[0].recipient, "alex@example.com");
  } finally {
    await f.close();
  }
});

test("deleting a partially paid invoice keeps recorded money and immutable receipts available", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    assert.equal((await f.payment(id, "25.00", "5.00")).status, 201);
    const snapshot = f.db
      .prepare("SELECT snapshot FROM receipts WHERE invoice_id=?")
      .get(id).snapshot;
    assert.equal((await f.remove(id)).status, 200);
    assert.equal(
      f.db
        .prepare("SELECT SUM(amount) amount FROM payments WHERE invoice_id=?")
        .get(id).amount,
      2500,
    );
    assert.equal(
      f.db.prepare("SELECT snapshot FROM receipts WHERE invoice_id=?").get(id)
        .snapshot,
      snapshot,
    );
    const receipts = (await f.request("/receipts", undefined, f.customer)).data
      .receipts;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].invoice_deleted, true);
    assert.equal(receipts[0].balance_after, 7500);
    assert.equal(receipts[0].tip_amount, 500);
    assert.equal(
      (await f.request("/receipts", undefined, f.other)).data.receipts.length,
      0,
    );
    await f.flushEmail();
    assert.ok(
      f.sent.some((message) => message.subject.startsWith("Thank you")),
      "receipt email survives deletion",
    );
    assert.ok(
      f.sent.some((message) => message.subject.startsWith("Payment recorded")),
      "money confirmation survives deletion",
    );
    assert.ok(
      !f.sent.some((message) =>
        message.subject.startsWith("Your invoice is ready"),
      ),
    );
  } finally {
    await f.close();
  }
});

test("amending paid invoices cannot reduce totals below money received and never rewrites earlier receipts", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    await f.payment(id, "40.00", "5.00");
    const receipt = f.db
      .prepare("SELECT snapshot FROM receipts WHERE invoice_id=?")
      .get(id).snapshot;
    const price = (value) => ({
      items: [
        { description: "Corrected service", quantity: 1, unit_amount: value },
      ],
    });
    assert.equal((await f.amend(id, price("39.99"))).status, 400);
    assert.equal((await f.details(id)).invoice.revision, 1);
    assert.equal((await f.amend(id, price("40.00"))).status, 200);
    assert.equal(
      (await f.details(id)).invoice.balance,
      0,
      "tips are separate from the minimum invoice total",
    );
    assert.equal((await f.amend(id, price("60.00"))).status, 200);
    const detail = await f.details(id);
    assert.equal(detail.invoice.paid, 4000);
    assert.equal(detail.invoice.balance, 2000);
    assert.equal(
      f.db.prepare("SELECT snapshot FROM receipts WHERE invoice_id=?").get(id)
        .snapshot,
      receipt,
    );
  } finally {
    await f.close();
  }
});

test("text-only amendments retain approved plans; changed totals close the plan and allow a fresh quote", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice(),
      plan = await f.plan(id);
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
    assert.equal(
      (await f.amend(id, { notes: "Updated instructions." })).status,
      200,
    );
    let detail = await f.details(id);
    assert.equal(detail.invoice.plan_fee, 225);
    assert.equal(detail.plans[0].status, "approved");
    assert.equal(
      (
        await f.amend(id, {
          items: [
            {
              description: "Updated service",
              quantity: 1,
              unit_amount: "200.00",
            },
          ],
        })
      ).status,
      200,
    );
    detail = await f.details(id);
    assert.equal(detail.invoice.total, 20000);
    assert.equal(detail.invoice.plan_fee, 0);
    assert.equal(detail.plans[0].status, "cancelled");
    assert.match(detail.plans[0].invalidated_reason, /Invoice amended/);
    assert.equal(
      detail.plans[0].installments.length,
      3,
      "old schedule is preserved for history",
    );
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
    const fresh = await f.plan(id);
    assert.equal(fresh.status, 201);
    assert.equal(
      (
        await f.request(
          `/plans/${fresh.data.id}/review`,
          { status: "approved" },
          f.admin,
        )
      ).status,
      200,
    );
    assert.equal((await f.details(id)).invoice.plan_fee, 450);
  } finally {
    await f.close();
  }
});

test("pending plan requests are invalidated and their queued request emails are superseded", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice(),
      plan = await f.plan(id);
    assert.equal((await f.amend(id, { payment_policy: "full" })).status, 200);
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
    assert.equal((await f.details(id)).plans[0].status, "cancelled");
    await f.flushEmail();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].body, /previous plan or request has been closed/);
  } finally {
    await f.close();
  }
});

test("pending payment notices block deletion and billing changes while allowing a text correction", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    const report = await f.request(
      `/invoices/${id}/payment-reports`,
      { amount: "100.00", method: "venmo", attestation: true },
      f.customer,
    );
    assert.equal((await f.remove(id)).status, 409);
    assert.equal((await f.amend(id, { due_date: "2027-02-10" })).status, 409);
    assert.equal(
      (await f.amend(id, { description: "Corrected title" })).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          `/payment-reports/${report.data.id}/review`,
          { status: "confirmed", verified: true, paid_date: "2027-01-01" },
          f.admin,
        )
      ).status,
      200,
    );
    assert.equal((await f.remove(id)).status, 200);
    assert.equal(
      (await f.request("/payment-reports", undefined, f.customer)).data.reports
        .length,
      0,
    );
    assert.equal(
      (await f.request("/receipts", undefined, f.customer)).data.receipts[0]
        .description,
      "Corrected title",
    );
  } finally {
    await f.close();
  }
});

test("amendments preserve existing late-fee charges and apply new terms prospectively", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice("100.00", { late_fee_enabled: true });
    f.set("2027-01-14");
    assert.equal(f.assessLateFees(), 1);
    assert.equal(
      (
        await f.amend(id, {
          due_date: "2027-02-10",
          items: [
            {
              description: "Corrected service",
              quantity: 1,
              unit_amount: "200.00",
            },
          ],
        })
      ).status,
      200,
    );
    const detail = await f.details(id);
    assert.equal(detail.invoice.late_fee_total, 200);
    assert.equal(detail.invoice.total, 20200);
    assert.equal(detail.late_fees[0].base_amount, 10000);
    f.set("2027-02-13");
    assert.equal(f.assessLateFees(), 0);
    f.set("2027-02-14");
    assert.equal(f.assessLateFees(), 1);
    assert.equal((await f.details(id)).invoice.late_fee_total, 600);
    const exempt = await f.invoice();
    assert.equal(
      (await f.amend(exempt, { late_fee_enabled: true })).status,
      200,
    );
    f.set("2027-02-17");
    assert.equal(f.assessLateFees(), 0);
    f.set("2027-02-18");
    assert.equal(
      f.assessLateFees(),
      1,
      "new policy waits three full days after amendment",
    );
  } finally {
    await f.close();
  }
});

test("only administrators can amend/delete and stale revisions, invalid fields and reassignment are rejected", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice(),
      body = await f.fields(id, { notes: "First edit" });
    const route = `/invoices/${id}/amend`;
    assert.equal((await f.request(route, body)).status, 401);
    for (const cookie of [f.customer, f.other]) {
      assert.equal((await f.request(route, body, cookie)).status, 403);
      assert.equal(
        (
          await f.request(
            `/invoices/${id}/delete`,
            { revision: 1, confirm_number: "INV-2027-0001", reason: "Delete" },
            cookie,
          )
        ).status,
        403,
      );
    }
    assert.equal(
      (await f.request(route, body, f.admin, "https://evil.example")).status,
      403,
    );
    for (const extra of [
      { customer_id: 3 },
      { due_date: "2027-02-30" },
      { discount_amount: "1000.00" },
      { reason: "" },
      { revision: undefined },
    ])
      assert.equal(
        (await f.request(route, { ...body, ...extra }, f.admin)).status,
        400,
      );
    assert.equal((await f.request(route, body, f.admin)).status, 200);
    assert.equal(
      (await f.request(route, { ...body, notes: "Stale edit" }, f.admin))
        .status,
      409,
    );
    assert.equal(
      (await f.amend(id)).status,
      400,
      "an unchanged form does not create another revision or email",
    );
    assert.equal(
      (
        await f.request(
          `/invoices/${id}/delete`,
          { revision: 2, confirm_number: "WRONG", reason: "Delete" },
          f.admin,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          `/invoices/${id}/delete`,
          { revision: 1, confirm_number: "INV-2027-0001", reason: "Delete" },
          f.admin,
        )
      ).status,
      409,
    );
    assert.equal((await f.details(id)).invoice.notes, "First edit");
    await f.flushEmail();
    assert.equal(f.sent.length, 1);
    assert.equal((await f.remove(id)).status, 200);
    assert.equal((await f.request(route, body, f.admin)).status, 404);
  } finally {
    await f.close();
  }
});

test("failed notification queue writes roll back amendments and deletion along with audit and email cancellation", async () => {
  const f = await fixture();
  try {
    const id = await f.invoice();
    f.db.exec(
      "CREATE TRIGGER fail_invoice_mail BEFORE INSERT ON email_outbox WHEN NEW.event_key LIKE 'invoice-amended-%' OR NEW.event_key LIKE 'invoice-deleted-%' BEGIN SELECT RAISE(ABORT,'Test invoice queue failure'); END;",
    );
    assert.equal(
      (await f.amend(id, { notes: "Should roll back" })).status,
      500,
    );
    assert.equal((await f.details(id)).invoice.notes, "");
    assert.equal((await f.details(id)).invoice.revision, 1);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) n FROM invoice_changes").get().n,
      0,
    );
    assert.equal(
      f.db.prepare("SELECT cancelled_at FROM email_outbox").get().cancelled_at,
      null,
    );
    assert.equal((await f.remove(id)).status, 500);
    assert.equal((await f.details(id)).invoice.deleted_at, null);
    f.db.exec("DROP TRIGGER fail_invoice_mail");
    assert.equal((await f.remove(id)).status, 200);
  } finally {
    await f.close();
  }
});

test("amendments, deletion and audits persist after reopening the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-changes-"));
  let f;
  try {
    const databasePath = join(directory, "billing.sqlite");
    f = await fixture({ databasePath });
    const amended = await f.invoice(),
      deleted = await f.invoice();
    await f.amend(amended, { notes: "Saved correction" });
    await f.remove(deleted);
    await f.close();
    f = await fixture({ databasePath });
    const invoices = (await f.request("/invoices", undefined, f.customer)).data
      .invoices;
    assert.deepEqual(
      invoices.map((invoice) => invoice.id),
      [amended],
    );
    assert.equal(invoices[0].notes, "Saved correction");
    assert.equal((await f.details(amended)).changes.length, 1);
    assert.equal((await f.details(deleted)).invoice.status, "deleted");
    await f.flushEmail();
    assert.equal(
      f.sent.filter((message) =>
        message.subject.startsWith("Your invoice has been"),
      ).length,
      2,
    );
  } finally {
    await f?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued legacy messages are associated on restart so deleting an invoice cancels stale plan notices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-legacy-mail-"));
  let f;
  try {
    const databasePath = join(directory, "billing.sqlite");
    f = await fixture({ databasePath });
    const id = await f.invoice();
    await f.plan(id);
    f.db.prepare("UPDATE email_outbox SET invoice_id=NULL").run();
    await f.close();
    f = await fixture({ databasePath });
    assert.equal((await f.remove(id)).status, 200);
    await f.flushEmail();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].subject, /invoice has been removed/);
  } finally {
    await f?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an email flush skips superseded messages even when its batch was fetched before an amendment", async () => {
  let release, started;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const firstStarted = new Promise((resolve) => {
    started = resolve;
  });
  const sent = [];
  const f = await fixture({
    mail: {
      send: async (message) => {
        sent.push(message);
        if (sent.length === 1) {
          started();
          await waiting;
        }
      },
    },
  });
  try {
    const id = await f.invoice();
    await f.plan(id);
    const flushing = f.flushEmail();
    await firstStarted;
    assert.equal((await f.amend(id, { payment_policy: "full" })).status, 200);
    release();
    await flushing;
    await f.flushEmail();
    assert.equal(
      sent.length,
      2,
      "already-sending ready message and latest amendment only",
    );
    assert.match(sent[1].subject, /invoice has been amended/);
    assert.ok(
      !sent.some((message) => message.subject.startsWith("Payment plan")),
    );
  } finally {
    release();
    await f.close();
  }
});

test("amending legacy invoices preserves their original policy and optional email stays disabled when unconfigured or in demo", async () => {
  for (const options of [{ demo: true }, { mail: { apiKey: "" } }]) {
    const f = await fixture(options);
    try {
      const id = await f.invoice();
      f.db
        .prepare("UPDATE invoices SET payment_policy='legacy' WHERE id=?")
        .run(id);
      assert.equal(
        (await f.amend(id, { notes: "Legacy correction" })).status,
        200,
      );
      assert.equal((await f.details(id)).invoice.payment_policy, "legacy");
      assert.equal((await f.remove(id)).status, 200);
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
