export function createReceipt(
  db,
  invoice,
  payment,
  businessName,
  notifications,
) {
  const snapshot = {
    business_name: businessName,
    invoice_number: invoice.number,
    description: invoice.description,
    customer_name: invoice.customer_name,
    customer_email: invoice.customer_email,
    paid_date: payment.paid_date,
    method: payment.method,
    reference: payment.reference,
    amount: payment.amount,
    tip_amount: payment.tip_amount,
    balance_after: invoice.balance - payment.amount,
    invoice_total: invoice.total,
    subtotal: invoice.subtotal,
    discount_amount: invoice.discount_amount,
    discount_label: invoice.discount_label,
    plan_fee: invoice.plan_fee,
    late_fee_total: invoice.late_fee_total,
    late_fees: db
      .prepare(
        "SELECT assessed_date,amount FROM late_fees WHERE invoice_id=? AND waived_at IS NULL ORDER BY assessed_date,id",
      )
      .all(invoice.id),
    items: db
      .prepare(
        "SELECT description,quantity,unit_amount FROM line_items WHERE invoice_id=? ORDER BY id",
      )
      .all(invoice.id),
  };
  const id = Number(
    db
      .prepare(
        "INSERT INTO receipts(payment_id,customer_id,invoice_id,snapshot) VALUES(?,?,?,?)",
      )
      .run(
        payment.id,
        invoice.customer_id,
        invoice.id,
        JSON.stringify(snapshot),
      ).lastInsertRowid,
  );
  notifications.receipt(snapshot, id);
  return id;
}

export function listReceipts(db, user) {
  return db
    .prepare(
      `SELECT id,payment_id,invoice_id,snapshot,created_at FROM receipts ${user.role === "admin" ? "" : "WHERE customer_id=?"} ORDER BY id DESC`,
    )
    .all(...(user.role === "admin" ? [] : [user.id]))
    .map(({ snapshot, ...row }) => ({ ...row, ...JSON.parse(snapshot) }));
}
