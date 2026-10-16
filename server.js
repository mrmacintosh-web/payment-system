import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { normalizeOrigin } from "./lib/origin.js";
import { createCsrfProtection } from "./lib/csrf.js";
import {
  openDatabase,
  hashPassword,
  verifyPassword,
  transaction,
  invoiceQuery,
  presentInvoice,
} from "./lib/database.js";

const root = dirname(fileURLToPath(import.meta.url));
const SESSION_SECONDS = 60 * 60 * 12;
const MAX_CENTS = 100_000_000;
const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
const tokenHash = (value) => createHash("sha256").update(value).digest("hex");
const safeUser = (u) => ({
  id: u.id,
  full_name: u.full_name,
  email: u.email,
  role: u.role,
  must_change_password: !!u.must_change_password,
});
const email = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    fail(400, "Enter a valid email address.");
  return normalized;
};
const text = (value, label, max = 500, optional = false) => {
  if (typeof value !== "string") {
    if (optional && value == null) return "";
    fail(400, `${label} is required.`);
  }
  const result = value.trim();
  if ((!optional && !result) || result.length > max)
    fail(
      400,
      `${label} must be ${optional ? "at most" : "between 1 and"} ${max} characters.`,
    );
  return result;
};
const password = (value) => {
  if (typeof value !== "string" || value.length < 12 || value.length > 128)
    fail(400, "Passwords must contain 12–128 characters.");
  return value;
};
const date = (value, label) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value ||
    value < "2000-01-01" ||
    value > "2100-12-31"
  )
    fail(400, `Enter a valid ${label}.`);
  return value;
};
const cents = (value, label = "Amount") => {
  if (typeof value !== "string" || !/^\d{1,7}(\.\d{1,2})?$/.test(value))
    fail(
      400,
      `${label} must be a positive amount with up to two decimal places.`,
    );
  const result = Math.round(Number(value) * 100);
  if (result < 1 || result > MAX_CENTS)
    fail(400, `${label} must be between $0.01 and $1,000,000.`);
  return result;
};
async function readBody(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    fail(415, "Send JSON data.");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 32_768) fail(413, "Request is too large.");
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    fail(400, "Invalid JSON request.");
  }
}

export function buildServer(options = {}) {
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const publicOrigin = normalizeOrigin(
    options.publicOrigin ?? process.env.PUBLIC_ORIGIN,
  );
  if (
    production &&
    (!publicOrigin ||
      new URL(publicOrigin).protocol !== "https:" ||
      new URL(publicOrigin).origin !== publicOrigin)
  )
    throw new Error(
      "Production requires PUBLIC_ORIGIN to be an exact HTTPS origin, e.g. https://billing.example.com",
    );
  const db = openDatabase(
    options.databasePath ||
      process.env.DATABASE_PATH ||
      resolve(root, ".data/billing.sqlite"),
  );
  const demo = options.demo ?? process.env.DEMO_MODE === "true";
  if (production && demo) {
    db.close();
    throw new Error("Demo mode cannot run in production.");
  }
  const codespacesProxy =
    !production &&
    (options.codespacesProxy ?? Boolean(process.env.CODESPACE_NAME));
  const csrf = codespacesProxy
    ? createCsrfProtection({
        secure: publicOrigin?.startsWith("https:"),
        lifetime: SESSION_SECONDS,
      })
    : null;
  const businessName =
    options.businessName ||
    process.env.BUSINESS_NAME ||
    "The Office of Yash SR: Payment Portal";
  const attempts = new Map();
  const dummyHash = hashPassword(randomBytes(24).toString("hex"));
  const cookieName = production ? "__Host-ledger_session" : "ledger_session";
  const cookie = (token, age) =>
    `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${production ? "; Secure" : ""}`;
  const invoiceFor = (id, user) => {
    const row = db
      .prepare(
        `${invoiceQuery} WHERE i.id=?${user.role === "customer" ? " AND i.customer_id=?" : ""}`,
      )
      .get(...(user.role === "customer" ? [id, user.id] : [id]));
    if (!row) fail(404, "Invoice not found.");
    return presentInvoice(row);
  };
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (production)
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    const json = (data, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (!path.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD")
          fail(405, "Method not allowed.");
        const files = {
          "/": ["index.html", "text/html"],
          "/app.js": ["app.js", "text/javascript"],
          "/styles.css": ["styles.css", "text/css"],
          "/favicon.png": ["brand/office-logo.png", "image/png"],
          "/brand/office-logo.png": ["brand/office-logo.png", "image/png"],
          "/fonts/glacial-indifference-regular.woff2": [
            "fonts/glacial-indifference-regular.woff2",
            "font/woff2",
          ],
          "/fonts/glacial-indifference-bold.woff2": [
            "fonts/glacial-indifference-bold.woff2",
            "font/woff2",
          ],
          "/fonts/OFL.txt": ["fonts/OFL.txt", "text/plain"],
        };
        if (!files[path]) fail(404, "Page not found.");
        const [file, type] = files[path];
        const body = await readFile(resolve(root, "public", file));
        res.writeHead(200, {
          "Content-Type":
            type.startsWith("text/") || type === "image/svg+xml"
              ? `${type}; charset=utf-8`
              : type,
          "Cache-Control": "no-cache",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      if (req.method === "GET" && path === "/api/health") {
        json({
          status: "ok",
          database: db.prepare("SELECT 1 AS ok").get().ok === 1,
        });
        return;
      }
      if (req.method === "GET" && path === "/api/config") {
        json({
          business_name: businessName,
          demo,
          currency: "USD",
          ...(csrf ? { csrf_token: csrf.issue(req, res) } : {}),
        });
        return;
      }
      if (!["GET", "POST"].includes(req.method))
        fail(405, "Method not allowed.");
      if (req.method === "POST") {
        const expectedOrigin = publicOrigin || `http://${req.headers.host}`;
        if (
          (req.headers.origin !== expectedOrigin && !csrf?.verify(req)) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          fail(
            403,
            csrf
              ? "Browser verification failed. Refresh this tab after restarting the server with npm run codespaces."
              : "Request origin is not allowed. Refresh the page and try again.",
          );
      }
      if (req.method === "POST" && path === "/api/login") {
        const body = await readBody(req);
        const address = email(body.email);
        if (typeof body.password !== "string" || body.password.length > 128)
          fail(400, "Enter your password.");
        const now = Date.now();
        for (const [key, value] of attempts)
          if (value.until < now) attempts.delete(key);
        const keys = [`ip:${req.socket.remoteAddress}`, `email:${address}`];
        if (keys.some((key) => (attempts.get(key)?.count || 0) >= 10))
          fail(429, "Too many sign-in attempts. Try again in 15 minutes.");
        const user = db
          .prepare("SELECT * FROM users WHERE email=?")
          .get(address);
        const valid = verifyPassword(
          body.password,
          user?.password_hash || dummyHash,
        );
        if (!valid || !user) {
          for (const key of keys) {
            const value = attempts.get(key) || {
              count: 0,
              until: now + 900_000,
            };
            value.count++;
            attempts.set(key, value);
          }
          fail(401, "Email or password is incorrect.");
        }
        attempts.delete(`email:${address}`);
        db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
        const token = randomBytes(32).toString("hex");
        db.prepare(
          "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        ).run(tokenHash(token), user.id, now + SESSION_SECONDS * 1000);
        res.setHeader("Set-Cookie", cookie(token, SESSION_SECONDS));
        json({ user: safeUser(user) });
        return;
      }
      const sessionToken = (req.headers.cookie || "")
        .split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      const user =
        sessionToken && /^[a-f0-9]{64}$/.test(sessionToken)
          ? db
              .prepare(
                "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?",
              )
              .get(tokenHash(sessionToken), Date.now())
          : null;
      if (!user) fail(401, "Please sign in to continue.");
      if (path === "/api/me" && req.method === "GET") {
        json({ user: safeUser(user) });
        return;
      }
      if (path === "/api/logout" && req.method === "POST") {
        db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
          tokenHash(sessionToken),
        );
        res.setHeader("Set-Cookie", cookie("", 0));
        json({ ok: true });
        return;
      }
      if (path === "/api/change-password" && req.method === "POST") {
        const body = await readBody(req);
        if (
          typeof body.current_password !== "string" ||
          body.current_password.length > 128 ||
          !verifyPassword(body.current_password, user.password_hash)
        )
          fail(400, "Your current password is incorrect.");
        const next = password(body.new_password);
        if (next === body.current_password)
          fail(400, "Choose a different password.");
        transaction(db, () => {
          db.prepare(
            "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
          ).run(hashPassword(next), user.id);
          db.prepare(
            "DELETE FROM sessions WHERE user_id=? AND token_hash<>?",
          ).run(user.id, tokenHash(sessionToken));
        });
        json({ ok: true });
        return;
      }
      if (user.must_change_password)
        fail(403, "Change your temporary password before continuing.");
      if (path === "/api/invoices" && req.method === "GET") {
        const rows =
          user.role === "admin"
            ? db.prepare(`${invoiceQuery} ORDER BY i.id DESC`).all()
            : db
                .prepare(
                  `${invoiceQuery} WHERE i.customer_id=? ORDER BY i.id DESC`,
                )
                .all(user.id);
        json({ invoices: rows.map(presentInvoice) });
        return;
      }
      let match = path.match(/^\/api\/invoices\/(\d+)$/);
      if (match && req.method === "GET") {
        const invoice = invoiceFor(Number(match[1]), user);
        json({
          invoice,
          items: db
            .prepare("SELECT * FROM line_items WHERE invoice_id=? ORDER BY id")
            .all(invoice.id),
          payments: db
            .prepare(
              "SELECT id,amount,paid_date,reference FROM payments WHERE invoice_id=? ORDER BY paid_date DESC,id DESC",
            )
            .all(invoice.id),
          plans: db
            .prepare(
              "SELECT id,monthly_amount,start_date,message,status,admin_note,created_at,reviewed_at FROM plan_requests WHERE invoice_id=? ORDER BY id DESC",
            )
            .all(invoice.id),
        });
        return;
      }
      if (path === "/api/plans" && req.method === "GET") {
        const query = `SELECT p.*, i.number AS invoice_number, i.description AS invoice_description, u.full_name AS customer_name FROM plan_requests p JOIN invoices i ON i.id=p.invoice_id JOIN users u ON u.id=p.customer_id`;
        json({
          plans:
            user.role === "admin"
              ? db.prepare(`${query} ORDER BY p.id DESC`).all()
              : db
                  .prepare(`${query} WHERE p.customer_id=? ORDER BY p.id DESC`)
                  .all(user.id),
        });
        return;
      }
      match = path.match(/^\/api\/invoices\/(\d+)\/plans$/);
      if (match && req.method === "POST") {
        if (user.role !== "customer")
          fail(403, "Only the customer can request a payment plan.");
        const body = await readBody(req);
        const invoice = invoiceFor(Number(match[1]), user);
        if (invoice.balance <= 0)
          fail(400, "This invoice has already been paid.");
        if (
          db
            .prepare(
              "SELECT id FROM plan_requests WHERE invoice_id=? AND status IN ('pending','approved')",
            )
            .get(invoice.id)
        )
          fail(
            409,
            "This invoice already has an active plan or a pending request.",
          );
        const amount = cents(body.monthly_amount, "Monthly amount");
        if (amount > invoice.balance)
          fail(400, "Monthly amount cannot exceed the remaining balance.");
        const start = date(body.start_date, "first payment date");
        if (start < new Date().toISOString().slice(0, 10))
          fail(400, "Choose today or a future first payment date.");
        const id = db
          .prepare(
            "INSERT INTO plan_requests(invoice_id,customer_id,monthly_amount,start_date,message) VALUES(?,?,?,?,?)",
          )
          .run(
            invoice.id,
            user.id,
            amount,
            start,
            text(body.message, "Message", 2000, true),
          ).lastInsertRowid;
        json({ id: Number(id) }, 201);
        return;
      }
      if (user.role !== "admin") fail(403, "Administrator access is required.");
      if (path === "/api/customers" && req.method === "GET") {
        json({
          customers: db
            .prepare(
              "SELECT id,full_name,email,created_at,must_change_password FROM users WHERE role='customer' ORDER BY full_name COLLATE NOCASE",
            )
            .all(),
        });
        return;
      }
      if (path === "/api/customers" && req.method === "POST") {
        const body = await readBody(req);
        const fullName = text(body.full_name, "Full name", 100),
          address = email(body.email),
          pass = password(body.password);
        if (db.prepare("SELECT id FROM users WHERE email=?").get(address))
          fail(409, "An account with this email already exists.");
        const id = db
          .prepare(
            "INSERT INTO users(full_name,email,password_hash,role,must_change_password) VALUES(?,?,?,'customer',1)",
          )
          .run(fullName, address, hashPassword(pass)).lastInsertRowid;
        json({ id: Number(id) }, 201);
        return;
      }
      match = path.match(/^\/api\/customers\/(\d+)\/reset-password$/);
      if (match && req.method === "POST") {
        const body = await readBody(req);
        const pass = password(body.password);
        if (
          !db
            .prepare("SELECT id FROM users WHERE id=? AND role='customer'")
            .get(Number(match[1]))
        )
          fail(404, "Customer not found.");
        transaction(db, () => {
          db.prepare(
            "UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?",
          ).run(hashPassword(pass), Number(match[1]));
          db.prepare("DELETE FROM sessions WHERE user_id=?").run(
            Number(match[1]),
          );
        });
        json({ ok: true });
        return;
      }
      if (path === "/api/invoices" && req.method === "POST") {
        const body = await readBody(req);
        if (
          !Number.isSafeInteger(body.customer_id) ||
          !db
            .prepare("SELECT id FROM users WHERE id=? AND role='customer'")
            .get(body.customer_id)
        )
          fail(400, "Choose a customer.");
        const description = text(body.description, "Invoice title", 160),
          due = date(body.due_date, "due date"),
          notes = text(body.notes, "Notes", 2000, true);
        if (
          !Array.isArray(body.items) ||
          body.items.length < 1 ||
          body.items.length > 50
        )
          fail(400, "Add between 1 and 50 line items.");
        const items = body.items.map((item) => {
          if (!item || typeof item !== "object")
            fail(400, "Invalid line item.");
          const description = text(item.description, "Charge description", 200),
            unit = cents(item.unit_amount, "Unit price");
          if (
            !Number.isSafeInteger(item.quantity) ||
            item.quantity < 1 ||
            item.quantity > 10000
          )
            fail(400, "Quantity must be a whole number between 1 and 10,000.");
          return { description, unit, quantity: item.quantity };
        });
        if (
          items.reduce((sum, item) => sum + item.unit * item.quantity, 0) >
          MAX_CENTS
        )
          fail(400, "Invoice total cannot exceed $1,000,000.");
        const id = transaction(db, () => {
          const today = new Date().toISOString().slice(0, 10);
          const id = Number(
            db
              .prepare(
                "INSERT INTO invoices(customer_id,description,issued_date,due_date,notes) VALUES(?,?,?,?,?)",
              )
              .run(body.customer_id, description, today, due, notes)
              .lastInsertRowid,
          );
          db.prepare("UPDATE invoices SET number=? WHERE id=?").run(
            `INV-${today.slice(0, 4)}-${String(id).padStart(4, "0")}`,
            id,
          );
          for (const item of items)
            db.prepare(
              "INSERT INTO line_items(invoice_id,description,quantity,unit_amount) VALUES(?,?,?,?)",
            ).run(id, item.description, item.quantity, item.unit);
          return id;
        });
        json({ id }, 201);
        return;
      }
      match = path.match(/^\/api\/invoices\/(\d+)\/payments$/);
      if (match && req.method === "POST") {
        const body = await readBody(req),
          invoice = invoiceFor(Number(match[1]), user);
        const amount = cents(body.amount),
          paidDate = date(body.paid_date, "payment date");
        if (paidDate > new Date().toISOString().slice(0, 10))
          fail(400, "Payment date cannot be in the future.");
        if (amount > invoice.balance)
          fail(400, "Payment cannot exceed the remaining balance.");
        const id = db
          .prepare(
            "INSERT INTO payments(invoice_id,amount,paid_date,reference,recorded_by) VALUES(?,?,?,?,?)",
          )
          .run(
            invoice.id,
            amount,
            paidDate,
            text(body.reference, "Reference", 200, true),
            user.id,
          ).lastInsertRowid;
        json({ id: Number(id) }, 201);
        return;
      }
      match = path.match(/^\/api\/plans\/(\d+)\/review$/);
      if (match && req.method === "POST") {
        const body = await readBody(req),
          plan = db
            .prepare("SELECT * FROM plan_requests WHERE id=?")
            .get(Number(match[1]));
        if (!plan) fail(404, "Request not found.");
        if (plan.status !== "pending")
          fail(409, "This request has already been reviewed.");
        if (!["approved", "declined"].includes(body.status))
          fail(400, "Choose approve or decline.");
        if (
          body.status === "approved" &&
          invoiceFor(plan.invoice_id, user).balance <= 0
        )
          fail(
            400,
            "This invoice is already paid. Decline the request with an explanation.",
          );
        db.prepare(
          "UPDATE plan_requests SET status=?,admin_note=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?",
        ).run(
          body.status,
          text(body.admin_note, "Response", 2000, true),
          user.id,
          plan.id,
        );
        json({ ok: true });
        return;
      }
      fail(404, "Endpoint not found.");
    } catch (error) {
      if (!error.status) console.error("Request failed:", error.message);
      if (!res.headersSent)
        json(
          {
            error: error.status
              ? error.message
              : "Something went wrong. Please try again.",
          },
          error.status || 500,
        );
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on("close", () => db.close());
  return { server, db };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { server } = buildServer();
  const port = Number(process.env.PORT || 3000),
    host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () =>
    console.log(
      `Billing portal listening on ${host}:${port}${process.env.DEMO_MODE === "true" ? " (demo database)" : ""}`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close(() => process.exit(0)));
}
