import { openDatabase, hashPassword, transaction } from "../lib/database.js";
import {
  adminCommandArguments,
  readNewAdminPassword,
} from "../lib/terminal-password.js";

let db;
try {
  const { address, showPassword } = adminCommandArguments(
    "reset-admin-password",
  );
  db = openDatabase(process.env.DATABASE_PATH || ".data/billing.sqlite");
  const user = db
    .prepare("SELECT id FROM users WHERE email=? AND role='admin'")
    .get(address);
  if (!user)
    throw new Error(
      "No administrator with that email was found. No account was changed.",
    );
  const pass = await readNewAdminPassword({ showPassword });
  transaction(db, () => {
    const result = db
      .prepare(
        "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=? AND role='admin'",
      )
      .run(hashPassword(pass), user.id);
    if (result.changes !== 1)
      throw new Error(
        "The administrator account changed. No password was reset.",
      );
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
  });
  console.log(
    "Administrator password updated. Previous sessions have been signed out. Your account, invoices, and payments are unchanged.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
