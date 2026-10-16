import { openDatabase, hashPassword, transaction } from "../lib/database.js";
import { buildServer } from "../server.js";
import { resolve } from "node:path";

if (process.env.NODE_ENV === "production")
  throw new Error("Demo mode is for local development only.");
const path = resolve(".data/demo.sqlite");
const db = openDatabase(path);
const today = new Date();
const offset = (days) =>
  new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
if (!db.prepare("SELECT id FROM users LIMIT 1").get())
  transaction(db, () => {
    const addUser = db.prepare(
      "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,?)",
    );
    const admin = Number(
      addUser.run(
        "Jordan Morgan",
        "admin@demo.local",
        hashPassword("DemoAdmin2026!"),
        "admin",
      ).lastInsertRowid,
    );
    const alex = Number(
      addUser.run(
        "Alex Johnson",
        "alex@demo.local",
        hashPassword("DemoClient2026!"),
        "customer",
      ).lastInsertRowid,
    );
    const sam = Number(
      addUser.run(
        "Sam Rivera",
        "sam@demo.local",
        hashPassword("DemoClient2026!"),
        "customer",
      ).lastInsertRowid,
    );
    const morgan = Number(
      addUser.run(
        "Morgan Chen",
        "morgan@demo.local",
        hashPassword("DemoClient2026!"),
        "customer",
      ).lastInsertRowid,
    );
    const invoice = (customer, title, issued, due, items, paid = 0) => {
      const id = Number(
        db
          .prepare(
            "INSERT INTO invoices(customer_id,description,issued_date,due_date,notes) VALUES(?,?,?,?,?)",
          )
          .run(
            customer,
            title,
            offset(issued),
            offset(due),
            "Thank you for your business. If you need a little flexibility, you can request a payment plan here.",
          ).lastInsertRowid,
      );
      db.prepare("UPDATE invoices SET number=? WHERE id=?").run(
        `INV-${today.getUTCFullYear()}-${String(id).padStart(4, "0")}`,
        id,
      );
      for (const [desc, qty, amount] of items)
        db.prepare(
          "INSERT INTO line_items(invoice_id,description,quantity,unit_amount) VALUES(?,?,?,?)",
        ).run(id, desc, qty, amount);
      if (paid)
        db.prepare(
          "INSERT INTO payments(invoice_id,amount,paid_date,reference,recorded_by) VALUES(?,?,?,?,?)",
        ).run(id, paid, offset(-3), "Bank transfer", admin);
      return id;
    };
    invoice(
      alex,
      "Website design & development",
      -18,
      10,
      [
        ["Website design", 1, 85000],
        ["Development & integration", 1, 55000],
        ["Hosting & maintenance", 1, 5000],
      ],
      25000,
    );
    invoice(alex, "Monthly care & support", -35, -5, [
      ["Monthly support", 3, 7500],
      ["Security & backups", 1, 5000],
    ]);
    invoice(
      alex,
      "Brand identity package",
      -60,
      -30,
      [
        ["Brand discovery", 1, 25000],
        ["Visual identity", 1, 50000],
      ],
      75000,
    );
    const requestInvoice = invoice(sam, "Consulting & strategy", -12, 18, [
      ["Strategy consultation", 4, 15000],
      ["Project roadmap", 1, 30000],
    ]);
    invoice(
      morgan,
      "Monthly maintenance",
      -10,
      20,
      [["Maintenance plan", 1, 35000]],
      35000,
    );
    db.prepare(
      "INSERT INTO plan_requests(invoice_id,customer_id,monthly_amount,start_date,message) VALUES(?,?,?,?,?)",
    ).run(
      requestInvoice,
      sam,
      30000,
      offset(7),
      "Could we split this into three monthly payments? That would really help with cash flow this month.",
    );
  });
db.close();
const { server } = buildServer({ databasePath: path, demo: true });
const port = Number(process.env.PORT || 3000);
server.listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(
    `Demo portal listening on port ${port}. Demo sign-in shortcuts are shown on the login page. This uses .data/demo.sqlite, separate from real billing data.`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
