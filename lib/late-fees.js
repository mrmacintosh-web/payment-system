import { invoiceQuery, presentInvoice, transaction } from "./database.js";
import { addDays, billingDate } from "./billing-dates.js";

export function createLateFees(
  db,
  { notifications, now = () => new Date(), demo = false },
) {
  const dayOf = (timestamp) =>
    billingDate(
      new Date(
        timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`,
      ),
    );

  function run({ insideTransaction = false, invoiceId = null } = {}) {
    if (demo) return 0;
    const today = billingDate(now());
    const candidates = db
      .prepare(
        `${invoiceQuery} WHERE i.late_fee_policy='weekly_2_percent' AND i.late_fee_start_date<=? AND (i.late_fee_checked_through IS NULL OR i.late_fee_checked_through<?) ${invoiceId === null ? "" : "AND i.id=?"} ORDER BY i.id`,
      )
      .all(today, today, ...(invoiceId === null ? [] : [invoiceId]));
    let count = 0;
    for (const candidate of candidates) {
      // A pending declaration is not payment, but review delays must not add fees.
      // Leave the cursor in place: confirmation uses the verified payment date;
      // rejection lets the worker assess the genuinely overdue periods.
      if (
        db
          .prepare(
            "SELECT id FROM payment_reports WHERE invoice_id=? AND status='pending'",
          )
          .get(candidate.id)
      )
        continue;
      const assess = () => {
        if (
          db
            .prepare(
              "SELECT id FROM payment_reports WHERE invoice_id=? AND status='pending'",
            )
            .get(candidate.id)
        )
          return 0;
        const invoice = presentInvoice(
          db.prepare(`${invoiceQuery} WHERE i.id=?`).get(candidate.id),
          today,
        );
        const start = invoice.late_fee_checked_through
          ? addDays(invoice.late_fee_checked_through, 1)
          : invoice.late_fee_start_date;
        const fees = db
          .prepare(
            "SELECT * FROM late_fees WHERE invoice_id=? ORDER BY assessed_date,id",
          )
          .all(invoice.id);
        const existing = new Map(fees.map((fee) => [fee.assessed_date, fee]));
        let lastAssessed = fees
          .filter((fee) => fee.assessed_date < start)
          .at(-1)?.assessed_date;
        const payments = db
          .prepare(
            "SELECT amount,paid_date FROM payments WHERE invoice_id=? ORDER BY paid_date,id",
          )
          .all(invoice.id);
        const plan = db
          .prepare(
            "SELECT * FROM plan_requests WHERE invoice_id=? AND status='approved'",
          )
          .get(invoice.id);
        const approvedOn = plan?.reviewed_at ? dayOf(plan.reviewed_at) : null;
        const installments = plan
          ? db
              .prepare(
                "SELECT due_date,amount FROM installments WHERE plan_id=? ORDER BY sequence",
              )
              .all(plan.id)
          : [];
        const waived = plan
          ? db
              .prepare(
                "SELECT f.amount,f.waived_at FROM plan_late_fees pf JOIN late_fees f ON f.id=pf.fee_id WHERE pf.plan_id=? AND f.waived_at IS NOT NULL",
              )
              .all(plan.id)
          : [];
        const weeklyAmount = Math.floor(
          (invoice.base_total * 200 + 5000) / 10000,
        );
        const added = [];
        for (let day = start; day <= today; day = addDays(day, 1)) {
          if (existing.has(day)) {
            lastAssessed = day;
            continue;
          }
          if (
            weeklyAmount < 1 ||
            (lastAssessed && day < addDays(lastAssessed, 7))
          )
            continue;
          const paid = payments
            .filter((payment) => payment.paid_date < day)
            .reduce((sum, payment) => sum + payment.amount, 0);
          const planActive = plan && approvedOn && approvedOn <= day;
          // Fees do not create further fees once the purchase/plan has been paid.
          const remaining =
            invoice.base_total + (planActive ? invoice.plan_fee : 0) - paid;
          if (remaining <= 0) continue;
          let dueDate = invoice.due_date;
          if (planActive) {
            // New invoices use fixed 3/6-month schedules. Refuse to infer fees
            // from a missing schedule instead of falling back to the old due date.
            if (!installments.length) continue;
            const applied = Math.max(
              0,
              paid -
                (plan.paid_at_request ??
                  invoice.base_total - plan.balance_at_request),
            );
            let credit = waived
              .filter((fee) => dayOf(fee.waived_at) <= day)
              .reduce((sum, fee) => sum + fee.amount, 0);
            const adjusted = installments.map((item) => ({ ...item }));
            for (let index = adjusted.length - 1; index >= 0; index--) {
              const used = Math.min(adjusted[index].amount, credit);
              adjusted[index].amount -= used;
              credit -= used;
            }
            let scheduled = 0;
            const unpaid = adjusted.find((item) => {
              scheduled += item.amount;
              return scheduled > applied;
            });
            dueDate = (unpaid || installments.at(-1)).due_date;
          }
          if (day < addDays(dueDate, 4)) continue;
          const id = Number(
            db
              .prepare(
                "INSERT INTO late_fees(invoice_id,assessed_date,due_date,amount,base_amount) VALUES(?,?,?,?,?)",
              )
              .run(invoice.id, day, dueDate, weeklyAmount, invoice.base_total)
              .lastInsertRowid,
          );
          const fee = {
            id,
            assessed_date: day,
            due_date: dueDate,
            amount: weeklyAmount,
            base_amount: invoice.base_total,
            waived_at: null,
          };
          added.push(fee);
          lastAssessed = day;
        }
        db.prepare(
          "UPDATE invoices SET late_fee_checked_through=? WHERE id=?",
        ).run(today, invoice.id);
        if (added.length)
          notifications.lateFeesCharged(
            presentInvoice(
              db.prepare(`${invoiceQuery} WHERE i.id=?`).get(invoice.id),
              today,
            ),
            added,
          );
        return added.length;
      };
      count += insideTransaction ? assess() : transaction(db, assess);
    }
    return count;
  }
  return { run };
}
