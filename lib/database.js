import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
        "invoices",
        {
          discount_amount:
            "INTEGER NOT NULL DEFAULT 0 CHECK(discount_amount >= 0)",
          discount_label: "TEXT NOT NULL DEFAULT ''",
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
  COALESCE((SELECT SUM(quantity * unit_amount) FROM line_items WHERE invoice_id=i.id),0) - i.discount_amount AS total,
  COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id=i.id),0) AS paid,
  COALESCE((SELECT SUM(tip_amount) FROM payments WHERE invoice_id=i.id),0) AS tips_received
  FROM invoices i JOIN users u ON u.id=i.customer_id`;

export function presentInvoice(row) {
  const balance = row.total - row.paid;
  return {
    ...row,
    balance,
    status:
      balance === 0
        ? "paid"
        : row.due_date < new Date().toISOString().slice(0, 10)
          ? "overdue"
          : row.paid > 0
            ? "partial"
            : "open",
  };
}
