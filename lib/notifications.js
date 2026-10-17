import { createHash, randomUUID } from "node:crypto";

const dollars = (amount) => `$${(amount / 100).toFixed(2)}`;

export function createNotifications(
  db,
  {
    demo,
    publicOrigin,
    customerOrigin = publicOrigin,
    adminOrigin = publicOrigin,
    businessName,
    mail = {},
  },
) {
  const key = mail.apiKey ?? process.env.RESEND_API_KEY;
  const from = mail.from ?? process.env.MAIL_FROM;
  const adminEmail = mail.adminEmail ?? process.env.ADMIN_EMAIL;
  const enabled =
    !demo &&
    !!key &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from || "") &&
    publicOrigin?.startsWith("https:");
  const send =
    mail.send ||
    (async (message, idempotencyKey) => {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          from,
          to: [message.recipient],
          subject: message.subject,
          text: message.body,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw new Error("Email provider did not accept the message.");
    });
  let running = null,
    stopped = false;
  function enqueue(eventKey, recipient, subject, body) {
    if (!enabled) return;
    db.prepare(
      "INSERT OR IGNORE INTO email_outbox(event_key,recipient,subject,body) VALUES(?,?,?,?)",
    ).run(eventKey, recipient, subject, body);
  }
  function notifyAdmins(eventKey, subject, body) {
    if (!enabled) return;
    const recipients = adminEmail
      ? [adminEmail]
      : db
          .prepare("SELECT email FROM users WHERE role='admin'")
          .all()
          .map((user) => user.email);
    for (const recipient of new Set(recipients))
      enqueue(`${eventKey}-${recipient}`, recipient, subject, body);
  }
  function lateFeePolicy(invoice) {
    return invoice.late_fee_policy === "weekly_2_percent"
      ? "\nLate-fee policy: after 3 full calendar days overdue, 2% of the purchase total after discounts is added on day 4 and every 7 days while overdue. Tips, plan fees, and earlier late fees are excluded from the calculation. Approved plans use installment due dates. Fees stop accruing once the purchase and plan fee are paid. Billing dates use America/New_York.\n"
      : "";
  }
  function lateFeesCharged(invoice, fees) {
    const total = fees.reduce((sum, fee) => sum + fee.amount, 0);
    const details = fees
      .map(
        (fee) =>
          `${fee.assessed_date}: ${dollars(fee.amount)} (payment due ${fee.due_date})`,
      )
      .join("\n");
    const key = `late-fees-${fees[0].id}-${fees.at(-1).id}`;
    enqueue(
      key,
      invoice.customer_email,
      `Late fee charged · ${invoice.number}`,
      `${businessName}\n\nHi ${invoice.customer_name},\n\nA late fee has been added because your invoice or a scheduled installment was more than 3 days overdue.\nInvoice: ${invoice.number}\nNew late fees: ${dollars(total)}\n${details}\nCurrent total due: ${dollars(invoice.balance)}\n${lateFeePolicy(invoice)}\nThe fee is added to your invoice; no money has been automatically withdrawn. Sign in to view the charges and payment options. If you already paid, submit a payment notice or contact The Office of Yash SR.\n\nView your invoice: ${customerOrigin}`,
    );
    notifyAdmins(
      key,
      `Late fee added · ${invoice.number}`,
      `${businessName}\n\nLate fees were added to ${invoice.customer_name}'s invoice (${invoice.customer_email}).\nInvoice: ${invoice.number}\nNew late fees: ${dollars(total)}\n${details}\nCurrent balance: ${dollars(invoice.balance)}\n\nReview the invoice: ${adminOrigin}`,
    );
  }
  function lateFeeWaived(fee, invoice, note) {
    enqueue(
      `late-fee-waived-${fee.id}`,
      invoice.customer_email,
      `Late fee waived · ${invoice.number}`,
      `${businessName}\n\nHi ${invoice.customer_name},\n\nAn administrator waived the ${dollars(fee.amount)} late fee dated ${fee.assessed_date} on ${invoice.number}.\nReason: ${note}\nCurrent balance: ${dollars(invoice.balance)}\n\nYour invoice and any affected installment balances have been updated.\nView your invoice: ${customerOrigin}`,
    );
    notifyAdmins(
      `late-fee-waived-${fee.id}`,
      `Late fee waived · ${invoice.number}`,
      `${businessName}\n\nThe ${dollars(fee.amount)} late fee dated ${fee.assessed_date} was waived for ${invoice.customer_name} (${invoice.customer_email}).\nReason: ${note}\nRemaining balance: ${dollars(invoice.balance)}\n\nReview the invoice: ${adminOrigin}`,
    );
  }
  function receipt(snapshot, receiptId) {
    enqueue(
      `receipt-${receiptId}`,
      snapshot.customer_email,
      `Thank you for your payment · ${snapshot.invoice_number}`,
      `${businessName}\n\nHi ${snapshot.customer_name},\n\nThank you for your payment of ${dollars(snapshot.amount + snapshot.tip_amount)}. We have confirmed receipt.\nInvoice: ${snapshot.invoice_number}\nApplied to invoice: ${dollars(snapshot.amount)}\nTip: ${dollars(snapshot.tip_amount)}\nPayment method: ${snapshot.method}\nPayment date: ${snapshot.paid_date}\nRemaining balance: ${dollars(snapshot.balance_after)}\nReceipt: RCP-${String(receiptId).padStart(6, "0")}\n\nYour receipt is available in your dashboard: ${customerOrigin}\n\nThe Office of Yash SR`,
    );
    notifyAdmins(
      `payment-recorded-${receiptId}`,
      `Payment recorded · ${snapshot.invoice_number}`,
      `${businessName}\n\nA verified payment has been recorded for ${snapshot.customer_name} (${snapshot.customer_email}).\nInvoice: ${snapshot.invoice_number}\nTotal received: ${dollars(snapshot.amount + snapshot.tip_amount)}\nApplied to invoice: ${dollars(snapshot.amount)}\nTip: ${dollars(snapshot.tip_amount)}\nPayment method: ${snapshot.method}\nPayment date: ${snapshot.paid_date}\nReference: ${snapshot.reference || "Not provided"}\nRemaining balance: ${dollars(snapshot.balance_after)}\nReceipt: RCP-${String(receiptId).padStart(6, "0")}\n\nReview payments and receipts: ${adminOrigin}`,
    );
  }
  function invoiceReady(invoice) {
    enqueue(
      `invoice-ready-${invoice.id}`,
      invoice.customer_email,
      `Your invoice is ready · ${invoice.number}`,
      `${businessName}\n\nHi ${invoice.customer_name},\n\nYour invoice is ready to view.\n\nInvoice: ${invoice.number}\nDescription: ${invoice.description}\nTotal due: ${dollars(invoice.balance)}\nDue date: ${invoice.due_date}\n${lateFeePolicy(invoice)}\nSign in to view your individual charges and payment options:\n${customerOrigin}\n\nThank you,\nThe Office of Yash SR`,
    );
  }
  function paymentReport(report, invoice) {
    notifyAdmins(
      `report-${report.id}`,
      `Verify ${report.method} payment · ${invoice.number}`,
      `${businessName}\n\n${invoice.customer_name} (${invoice.customer_email}) says they sent ${dollars(report.amount + report.tip_amount)} through ${report.method}.\nInvoice: ${invoice.number}\nInvoice portion: ${dollars(report.amount)}\nTip: ${dollars(report.tip_amount)}\nReference: ${report.reference || "Not provided"}\n\nThis is a customer declaration, not verified payment. Check your own Venmo or Zelle account before confirming it in Payment notices. The balance has not changed.\n\nOpen the portal: ${adminOrigin}`,
    );
    enqueue(
      `report-received-${report.id}`,
      invoice.customer_email,
      `Payment notice received — pending review · ${invoice.number}`,
      `${businessName}\n\nHi ${invoice.customer_name},\n\nThank you for letting us know about your ${report.method} payment of ${dollars(report.amount + report.tip_amount)}. Your payment is pending review by an administrator.\nInvoice: ${invoice.number}\nInvoice portion: ${dollars(report.amount)}\nTip: ${dollars(report.tip_amount)}\nReference: ${report.reference || "Not provided"}\n\nThis acknowledges your payment notice. Your balance has not changed yet. After verification, you will receive a receipt and your dashboard balance will update. Please do not send another payment while this notice is under review.\n\nView payment status: ${customerOrigin}`,
    );
  }
  function paymentRejected(report, invoice, note) {
    enqueue(
      `report-rejected-${report.id}`,
      invoice.customer_email,
      `Payment could not be verified · ${invoice.number}`,
      `${businessName}\n\nHi ${invoice.customer_name},\n\nAn administrator reviewed your ${report.method} payment notice for ${dollars(report.amount + report.tip_amount)} and could not verify receipt.\nInvoice: ${invoice.number}\nReference: ${report.reference || "Not provided"}\nCurrent balance: ${dollars(invoice.balance)}\n${note ? `\nAdministrator's note: ${note}\n` : ""}\nThis notice did not reduce your balance or create a receipt. If you already sent the payment, check its recipient and status in your payment app and contact The Office of Yash SR before sending it again. You can submit a new notice from the portal once resolved.\n\nView your invoice: ${customerOrigin}`,
    );
  }
  function planDetails(plan) {
    return plan.term_months > 0
      ? `Term: ${plan.term_months} months\nOne-time plan fee: ${dollars(plan.fee_amount)} (${(plan.fee_bps / 100).toFixed(2)}% of the full purchase after discounts, excluding tips)\nTotal to schedule, including fee: ${dollars(plan.scheduled_total)}\nFirst payment date: ${plan.start_date}`
      : `Proposed monthly amount: ${dollars(plan.monthly_amount)}\nFirst payment date: ${plan.start_date}`;
  }
  function planRequested(plan, invoice) {
    notifyAdmins(
      `plan-requested-${plan.id}`,
      `Payment plan requested · ${invoice.number}`,
      `${businessName}\n\n${invoice.customer_name} (${invoice.customer_email}) requested a payment plan.\nInvoice: ${invoice.number}\nCurrent balance: ${dollars(invoice.balance)}\n${planDetails(plan)}\nCustomer's note: ${plan.message || "Not provided"}\n\nThis request is pending. No fee has been added. Review and approve or decline it in Payment plans:\n${adminOrigin}`,
    );
    enqueue(
      `plan-request-received-${plan.id}`,
      invoice.customer_email,
      `Payment plan request received · ${invoice.number}`,
      `${businessName}\n\nHi ${invoice.customer_name},\n\nWe received your payment plan request for ${invoice.number}.\n${planDetails(plan)}\n\nYour request is pending administrator review. It has not been approved, no fee has been added, and your current balance and invoice due date remain unchanged. We will email you when a decision is made.\n\nView your request: ${customerOrigin}`,
    );
  }
  function planReviewed(plan, invoice) {
    const approved = plan.status === "approved";
    const schedule =
      approved && plan.installments?.length
        ? `\nApproved payment schedule:\n${plan.installments.map((item) => `${item.due_date}: ${dollars(item.amount)}`).join("\n")}\n\nPayments are not automatic. Submit each payment using the portal's payment instructions.`
        : approved
          ? `\nApproved monthly amount: ${dollars(plan.monthly_amount)}\nFirst payment date: ${plan.start_date}\nPayments are not automatic.`
          : "\nNo plan fee was added for this declined request. You can review available payment options and submit a new request in the portal.";
    enqueue(
      `plan-reviewed-${plan.id}`,
      invoice.customer_email,
      `Payment plan ${approved ? "approved" : "declined"} · ${invoice.number}`,
      `${businessName}\n\nHi ${invoice.customer_name},\n\nYour payment plan request for ${invoice.number} has been ${approved ? "approved" : "declined"}.\n${approved ? `${planDetails(plan)}\n` : ""}Current balance: ${dollars(invoice.balance)}\n${plan.admin_note ? `\nAdministrator's note: ${plan.admin_note}\n` : ""}${schedule}\n${approved ? lateFeePolicy(invoice) : ""}\nView your invoice and plan: ${customerOrigin}`,
    );
  }
  function accountCreated(user) {
    enqueue(
      `account-created-${user.id}`,
      user.email,
      "Your payment portal account is ready",
      `${businessName}\n\nHi ${user.full_name},\n\nThe Office of Yash SR has created your payment portal account. Use this email address to sign in:\n${publicOrigin}\n\nYour temporary password will be shared separately by the office. You will be asked to choose a new password at your first sign-in. Your invoices, payment plans, and receipts will be available in your dashboard.\n\nIf you were not expecting this account, contact The Office of Yash SR.`,
    );
  }
  function passwordChanged(user, byAdmin = false) {
    enqueue(
      `password-changed-${user.id}-${randomUUID()}`,
      user.email,
      byAdmin
        ? "Your payment portal password was reset"
        : "Your payment portal password was changed",
      `${businessName}\n\nHi ${user.full_name},\n\n${byAdmin ? "An administrator reset your payment portal password. Your previous sessions have been signed out. Contact the office for your temporary password, which will be shared separately. You must choose a new password at your next sign-in." : "Your payment portal password was changed. Your other sessions have been signed out."}\n\nIf you did not request or make this change, contact The Office of Yash SR immediately.\n\nSign in: ${publicOrigin}`,
    );
  }
  async function flush() {
    if (!enabled || stopped) return;
    if (running) return running;
    running = (async () => {
      const messages = db
        .prepare(
          "SELECT * FROM email_outbox WHERE status='pending' AND attempts<12 AND next_attempt<=? ORDER BY id LIMIT 10",
        )
        .all(Date.now());
      for (const message of messages) {
        if (stopped) break;
        try {
          await send(
            message,
            `office-yash-${createHash("sha256").update(`${message.event_key}\n${message.recipient}\n${message.subject}\n${message.body}`).digest("hex")}`,
          );
          db.prepare(
            "UPDATE email_outbox SET status='sent',sent_at=datetime('now'),attempts=attempts+1 WHERE id=?",
          ).run(message.id);
        } catch {
          // A mail failure never rolls back a recorded payment or dashboard receipt.
          const delay = Math.min(3600000, 30000 * 2 ** message.attempts);
          db.prepare(
            "UPDATE email_outbox SET attempts=attempts+1,next_attempt=? WHERE id=?",
          ).run(Date.now() + delay, message.id);
        }
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  }
  const timer = enabled
    ? setInterval(() => {
        void flush();
      }, 30000)
    : null;
  timer?.unref();
  return {
    invoiceReady,
    receipt,
    paymentReport,
    paymentRejected,
    planRequested,
    planReviewed,
    accountCreated,
    passwordChanged,
    lateFeesCharged,
    lateFeeWaived,
    flush,
    status: () => ({
      enabled,
      demo_disabled: !!demo,
      pending: db
        .prepare(
          "SELECT COUNT(*) AS n FROM email_outbox WHERE status='pending'",
        )
        .get().n,
      sent: db
        .prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status='sent'")
        .get().n,
    }),
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
