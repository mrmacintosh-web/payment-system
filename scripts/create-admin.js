import { openDatabase, hashPassword } from "../lib/database.js";
import {
  adminCommandArguments,
  readNewAdminPassword,
} from "../lib/terminal-password.js";

let db;
try {
  const { address, showPassword } = adminCommandArguments("create-admin");
  db = openDatabase(process.env.DATABASE_PATH || ".data/billing.sqlite");
  if (db.prepare("SELECT id FROM users WHERE email=?").get(address))
    throw new Error("That account already exists; no account was changed.");
  const pass = await readNewAdminPassword({ showPassword });
  db.prepare(
    "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,'admin')",
  ).run("Administrator", address, hashPassword(pass));
  console.log(
    "Administrator created. Start the portal and sign in with your email and password.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
