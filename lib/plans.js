export const PLAN_TERMS = [
  { months: 3, minimum: 5000, fee_bps: 225 },
  { months: 6, minimum: 25000, fee_bps: 455 },
];

export function planOptions(invoice) {
  if (
    invoice.payment_policy !== "eligible" ||
    invoice.balance <= 0 ||
    invoice.plan_fee > 0
  )
    return [];
  return PLAN_TERMS.filter((term) => invoice.base_total >= term.minimum).map(
    (term) => {
      // Integer cents and basis points: one fee on the full discounted purchase, never on tips.
      const fee = Math.floor(
        (invoice.base_total * term.fee_bps + 5000) / 10000,
      );
      const total = invoice.balance + fee;
      return {
        ...term,
        fee_amount: fee,
        scheduled_total: total,
        monthly_amount: Math.floor(total / term.months),
        final_amount:
          total - Math.floor(total / term.months) * (term.months - 1),
      };
    },
  );
}

export function makeSchedule(startDate, months, total) {
  const [year, month, day] = startDate.split("-").map(Number);
  const monthly = Math.floor(total / months);
  return Array.from({ length: months }, (_, index) => {
    const first = new Date(Date.UTC(year, month - 1 + index, 1));
    const lastDay = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
    first.setUTCDate(Math.min(day, lastDay));
    return {
      sequence: index + 1,
      due_date: first.toISOString().slice(0, 10),
      amount: index === months - 1 ? total - monthly * (months - 1) : monthly,
    };
  });
}

export function presentPlan(db, plan, invoice) {
  const applied = Math.max(
    0,
    invoice.paid - (invoice.base_total - plan.balance_at_request),
  );
  let remainingPaid = applied;
  const installments = db
    .prepare(
      "SELECT sequence,due_date,amount FROM installments WHERE plan_id=? ORDER BY sequence",
    )
    .all(plan.id)
    .map((item) => {
      const paid = Math.min(item.amount, remainingPaid);
      remainingPaid -= paid;
      return { ...item, paid, balance: item.amount - paid };
    });
  return { ...plan, installments };
}
