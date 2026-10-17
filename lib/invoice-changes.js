import { invoiceQuery, presentInvoice, transaction } from "./database.js";
import { addDays, billingDate } from "./billing-dates.js";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

export function createInvoiceChanges(db, { notifications, now }) {
  const read = (id) => {
    const row = db.prepare(`${invoiceQuery} WHERE i.id=?`).get(id);
    return row ? presentInvoice(row, billingDate(now())) : null;
  };
  const itemsFor = (id) =>
    db
      .prepare(
        "SELECT description,quantity,unit_amount FROM line_items WHERE invoice_id=? ORDER BY id",
      )
      .all(id);
  function snapshot(id) {
    return JSON.stringify({
      invoice: read(id),
      items: itemsFor(id),
      plans: db
        .prepare("SELECT * FROM plan_requests WHERE invoice_id=? ORDER BY id")
        .all(id)
        .map((plan) => ({
          ...plan,
          installments: db
            .prepare(
              "SELECT * FROM installments WHERE plan_id=? ORDER BY sequence",
            )
            .all(plan.id),
        })),
      late_fees: db
        .prepare("SELECT * FROM late_fees WHERE invoice_id=? ORDER BY id")
        .all(id),
    });
  }
  function current(id, revision) {
    const invoice = read(id);
    if (!invoice || invoice.deleted_at) fail(404, "Invoice not found.");
    if (invoice.revision !== revision)
      fail(409, "This invoice changed. Reopen it before trying again.");
    return invoice;
  }
  function invalidatePlans(id, reason, userId, timestamp) {
    db.prepare(
      "UPDATE plan_requests SET invalidated_at=?,invalidated_by=?,invalidated_reason=? WHERE invoice_id=? AND status IN ('pending','approved') AND invalidated_at IS NULL",
    ).run(timestamp, userId, reason, id);
  }
  function audit(id, action, reason, userId, before, timestamp) {
    return Number(
      db
        .prepare(
          "INSERT INTO invoice_changes(invoice_id,revision,action,reason,changed_by,created_at,before_snapshot,after_snapshot) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          read(id).revision,
          action,
          reason,
          userId,
          timestamp,
          before,
          snapshot(id),
        ).lastInsertRowid,
    );
  }
  function amend(id, revision, fields, reason, userId) {
    return transaction(db, () => {
      const invoice = current(id, revision);
      const originalItems = itemsFor(id);
      const base =
        fields.items.reduce((sum, item) => sum + item.quantity * item.unit, 0) -
        fields.discount;
      const latePolicy = fields.lateFeeEnabled ? "weekly_2_percent" : "none";
      const termsChanged =
        base !== invoice.base_total || fields.policy !== invoice.payment_policy;
      const billingChanged =
        termsChanged ||
        fields.due !== invoice.due_date ||
        latePolicy !== invoice.late_fee_policy;
      const nextItems = fields.items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unit_amount: item.unit,
      }));
      const unchanged =
        JSON.stringify(originalItems) === JSON.stringify(nextItems) &&
        fields.description === invoice.description &&
        fields.notes === invoice.notes &&
        fields.due === invoice.due_date &&
        fields.discount === invoice.discount_amount &&
        fields.discountLabel === invoice.discount_label &&
        fields.policy === invoice.payment_policy &&
        latePolicy === invoice.late_fee_policy;
      if (unchanged) fail(400, "No invoice changes to save.");
      if (
        billingChanged &&
        db
          .prepare(
            "SELECT id FROM payment_reports WHERE invoice_id=? AND status='pending'",
          )
          .get(id)
      )
        fail(
          409,
          "Review the pending payment notice before changing the amount, due date, or payment terms.",
        );
      const planFee = termsChanged ? 0 : invoice.plan_fee;
      const plansClosed =
        termsChanged &&
        !!db
          .prepare(
            "SELECT id FROM plan_requests WHERE invoice_id=? AND status IN ('pending','approved') AND invalidated_at IS NULL",
          )
          .get(id);
      if (base + planFee + invoice.late_fee_total < invoice.paid)
        fail(
          400,
          `The amended total cannot be less than $${(invoice.paid / 100).toFixed(2)} already paid. A refund needs separate handling.`,
        );
      const before = snapshot(id),
        timestamp = now().toISOString(),
        today = billingDate(now());
      const start =
        billingChanged && fields.lateFeeEnabled
          ? [invoice.late_fee_start_date || today, addDays(today, 4)]
              .sort()
              .at(-1)
          : invoice.late_fee_start_date;
      db.prepare(
        "UPDATE invoices SET description=?,due_date=?,notes=?,discount_amount=?,discount_label=?,payment_policy=?,plan_fee=?,late_fee_policy=?,late_fee_start_date=?,late_fee_checked_through=?,revision=revision+1,amended_at=? WHERE id=?",
      ).run(
        fields.description,
        fields.due,
        fields.notes,
        fields.discount,
        fields.discountLabel,
        fields.policy,
        planFee,
        latePolicy,
        start,
        billingChanged ? today : invoice.late_fee_checked_through,
        timestamp,
        id,
      );
      db.prepare("DELETE FROM line_items WHERE invoice_id=?").run(id);
      const insert = db.prepare(
        "INSERT INTO line_items(invoice_id,description,quantity,unit_amount) VALUES(?,?,?,?)",
      );
      for (const item of fields.items)
        insert.run(id, item.description, item.quantity, item.unit);
      if (termsChanged)
        invalidatePlans(
          id,
          "Invoice amended. Please request a new plan for the updated invoice.",
          userId,
          timestamp,
        );
      const changeId = audit(id, "amended", reason, userId, before, timestamp);
      notifications.invoiceAmended(read(id), invoice, changeId, reason, {
        plansClosed,
        termsChanged,
      });
      return { id, revision: revision + 1 };
    });
  }
  function remove(id, revision, reason, userId) {
    return transaction(db, () => {
      const invoice = current(id, revision);
      if (
        db
          .prepare(
            "SELECT id FROM payment_reports WHERE invoice_id=? AND status='pending'",
          )
          .get(id)
      )
        fail(
          409,
          "Review the pending payment notice before deleting this invoice.",
        );
      const before = snapshot(id),
        timestamp = now().toISOString();
      db.prepare(
        "UPDATE invoices SET deleted_at=?,deleted_by=?,deletion_reason=?,revision=revision+1 WHERE id=?",
      ).run(timestamp, userId, reason, id);
      invalidatePlans(id, "Invoice deleted.", userId, timestamp);
      const changeId = audit(id, "deleted", reason, userId, before, timestamp);
      notifications.invoiceDeleted(invoice, changeId, reason);
      return { ok: true, id };
    });
  }
  return { amend, remove };
}
