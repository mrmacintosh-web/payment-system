import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { billingDate } from "./billing-dates.js";

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [salt, digest] = stored.split(":");
  const hash = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

export function openDatabase(filename) {
  const path = filename === ":memory:" ? filename : resolve(filename);
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin', 'customer')),
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES users(id),
      number TEXT UNIQUE, description TEXT NOT NULL, issued_date TEXT NOT NULL,
      due_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS invoices_customer ON invoices(customer_id);
    CREATE TABLE IF NOT EXISTS line_items (
      id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      description TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_amount INTEGER NOT NULL CHECK(unit_amount > 0)
    );
    CREATE INDEX IF NOT EXISTS items_invoice ON line_items(invoice_id);
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      amount INTEGER NOT NULL CHECK(amount > 0), paid_date TEXT NOT NULL,
      reference TEXT NOT NULL DEFAULT '', recorded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS payments_invoice ON payments(invoice_id);
    CREATE TABLE IF NOT EXISTS plan_requests (
      id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      customer_id INTEGER NOT NULL REFERENCES users(id), monthly_amount INTEGER NOT NULL CHECK(monthly_amount > 0),
      start_date TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'declined')),
      admin_note TEXT NOT NULL DEFAULT '', reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS plans_customer ON plan_requests(customer_id);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_plan ON plan_requests(invoice_id)
      WHERE status IN ('pending', 'approved');
    CREATE TABLE IF NOT EXISTS payment_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      cash_instructions TEXT NOT NULL DEFAULT 'Please pay in person. Your invoice will be updated after payment is received.',
      venmo_username TEXT NOT NULL DEFAULT '', venmo_qr TEXT NOT NULL DEFAULT '',
      zelle_number TEXT NOT NULL DEFAULT '', zelle_qr TEXT NOT NULL DEFAULT ''
    );
    INSERT OR IGNORE INTO payment_settings(id) VALUES(1);
  `);
  // Additive upgrades preserve existing invoices, payments, and customer data.
  transaction(db, () => {
    for (const [table, columns] of [
      [
        "sessions",
        {
          family_id: "TEXT NOT NULL DEFAULT ''",
          audience: "TEXT NOT NULL DEFAULT ''",
        },
      ],
      [
        "invoices",
        {
          discount_amount:
            "INTEGER NOT NULL DEFAULT 0 CHECK(discount_amount >= 0)",
          discount_label: "TEXT NOT NULL DEFAULT ''",
          payment_policy:
            "TEXT NOT NULL DEFAULT 'legacy' CHECK(payment_policy IN ('legacy','full','eligible'))",
          plan_fee: "INTEGER NOT NULL DEFAULT 0 CHECK(plan_fee >= 0)",
          late_fee_policy:
            "TEXT NOT NULL DEFAULT 'none' CHECK(late_fee_policy IN ('none','weekly_2_percent'))",
          late_fee_start_date: "TEXT",
          late_fee_checked_through: "TEXT",
        },
      ],
      [
        "plan_requests",
        {
          term_months: "INTEGER NOT NULL DEFAULT 0",
          fee_bps: "INTEGER NOT NULL DEFAULT 0",
          fee_amount: "INTEGER NOT NULL DEFAULT 0",
          balance_at_request: "INTEGER NOT NULL DEFAULT 0",
          scheduled_total: "INTEGER NOT NULL DEFAULT 0",
          paid_at_request: "INTEGER",
        },
      ],
      [
        "payments",
        {
          tip_amount: "INTEGER NOT NULL DEFAULT 0 CHECK(tip_amount >= 0)",
          method:
            "TEXT NOT NULL DEFAULT 'other' CHECK(method IN ('cash','venmo','zelle','other'))",
        },
      ],
    ]) {
      const existing = new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name),
      );
      for (const [column, definition] of Object.entries(columns)) {
        if (!existing.has(column))
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS sessions_family ON sessions(family_id);
    CREATE TABLE IF NOT EXISTS login_handoffs (
      code_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      login_session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
      state_hash TEXT NOT NULL, target_origin TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS installments (
      id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES plan_requests(id),
      sequence INTEGER NOT NULL, due_date TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0),
      UNIQUE(plan_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS payment_reports (
      id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      customer_id INTEGER NOT NULL REFERENCES users(id),
      method TEXT NOT NULL CHECK(method IN ('venmo','zelle')),
      amount INTEGER NOT NULL CHECK(amount>0), tip_amount INTEGER NOT NULL DEFAULT 0 CHECK(tip_amount>=0),
      reference TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
      admin_note TEXT NOT NULL DEFAULT '', reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT,
      payment_id INTEGER UNIQUE REFERENCES payments(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_report ON payment_reports(invoice_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id),
      customer_id INTEGER NOT NULL REFERENCES users(id), invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      snapshot TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS receipts_customer ON receipts(customer_id);
    CREATE TABLE IF NOT EXISTS email_outbox (
      id INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, recipient TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS late_fees (
      id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      assessed_date TEXT NOT NULL, due_date TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount>0), base_amount INTEGER NOT NULL CHECK(base_amount>0),
      waived_at TEXT, waived_by INTEGER REFERENCES users(id), waiver_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(invoice_id,assessed_date)
    );
    CREATE INDEX IF NOT EXISTS late_fees_invoice ON late_fees(invoice_id);
    CREATE TABLE IF NOT EXISTS plan_late_fees (
      plan_id INTEGER NOT NULL REFERENCES plan_requests(id),
      fee_id INTEGER NOT NULL REFERENCES late_fees(id),
      PRIMARY KEY(plan_id,fee_id)
    );
  `);
  return db;
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export const invoiceQuery = `SELECT i.*, u.full_name AS customer_name, u.email AS customer_email,
  COALESCE((SELECT SUM(quantity * unit_amount) FROM line_items WHERE invoice_id=i.id),0) AS subtotal,
  COALESCE((SELECT SUM(quantity * unit_amount) FROM line_items WHERE invoice_id=i.id),0) - i.discount_amount AS base_total,
  COALESCE((SELECT SUM(amount) FROM late_fees WHERE invoice_id=i.id AND waived_at IS NULL),0) AS late_fee_total,
  COALESCE((SELECT SUM(quantity * unit_amount) FROM line_items WHERE invoice_id=i.id),0) - i.discount_amount + i.plan_fee + COALESCE((SELECT SUM(amount) FROM late_fees WHERE invoice_id=i.id AND waived_at IS NULL),0) AS total,
  COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id=i.id),0) AS paid,
  COALESCE((SELECT SUM(tip_amount) FROM payments WHERE invoice_id=i.id),0) AS tips_received
  FROM invoices i JOIN users u ON u.id=i.customer_id`;

export function presentInvoice(row, today = billingDate()) {
  const balance = row.total - row.paid;
  return {
    ...row,
    balance,
    status:
      balance === 0
        ? "paid"
        : row.due_date < today
          ? "overdue"
          : row.paid > 0
            ? "partial"
            : "open",
  };
}
