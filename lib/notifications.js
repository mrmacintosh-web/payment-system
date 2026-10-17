import { createHash } from "node:crypto";

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
  function receipt(snapshot, receiptId) {
    enqueue(
      `receipt-${receiptId}`,
      snapshot.customer_email,
      `Thank you for your payment · ${snapshot.invoice_number}`,
      `${businessName}\n\nHi ${snapshot.customer_name},\n\nThank you for your payment of ${dollars(snapshot.amount + snapshot.tip_amount)}. We have confirmed receipt.\nInvoice: ${snapshot.invoice_number}\nApplied to invoice: ${dollars(snapshot.amount)}\nTip: ${dollars(snapshot.tip_amount)}\nPayment method: ${snapshot.method}\nPayment date: ${snapshot.paid_date}\nRemaining balance: ${dollars(snapshot.balance_after)}\nReceipt: RCP-${String(receiptId).padStart(6, "0")}\n\nYour receipt is available in your dashboard: ${customerOrigin}\n\nThe Office of Yash SR`,
    );
  }
  function paymentReport(report, invoice) {
    const recipients = adminEmail
      ? [adminEmail]
      : db
          .prepare("SELECT email FROM users WHERE role='admin'")
          .all()
          .map((user) => user.email);
    for (const recipient of recipients)
      enqueue(
        `report-${report.id}-${recipient}`,
        recipient,
        `Verify ${report.method} payment · ${invoice.number}`,
        `${businessName}\n\n${invoice.customer_name} (${invoice.customer_email}) says they sent ${dollars(report.amount + report.tip_amount)} through ${report.method}.\nInvoice: ${invoice.number}\nInvoice portion: ${dollars(report.amount)}\nTip: ${dollars(report.tip_amount)}\nReference: ${report.reference || "Not provided"}\n\nThis is a customer declaration, not verified payment. Check your own Venmo or Zelle account before confirming it in Payment notices. The balance has not changed.\n\nOpen the portal: ${adminOrigin}`,
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
    receipt,
    paymentReport,
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
