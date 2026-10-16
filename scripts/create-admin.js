import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { openDatabase, hashPassword } from "../lib/database.js";

const address = process.argv[2]?.trim().toLowerCase();
if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
  console.error("Usage: npm run create-admin -- admin@example.com");
  process.exit(1);
}
const db = openDatabase(process.env.DATABASE_PATH || ".data/billing.sqlite");
try {
  if (db.prepare("SELECT id FROM users WHERE email=?").get(address))
    throw new Error("That account already exists; no account was changed.");
  let pass = process.env.ADMIN_PASSWORD;
  if (!pass) {
    if (!process.stdin.isTTY)
      throw new Error(
        "Run in an interactive terminal or provide ADMIN_PASSWORD through a secure environment variable.",
      );
    let hidden = false;
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!hidden) process.stdout.write(chunk);
        callback();
      },
    });
    const rl = createInterface({
      input: process.stdin,
      output,
      terminal: true,
    });
    process.stdout.write(
      "Administrator password (12–128 characters, hidden): ",
    );
    hidden = true;
    pass = await new Promise((resolve) => rl.question("", resolve));
    rl.close();
    process.stdout.write("\n");
  }
  if (pass.length < 12 || pass.length > 128)
    throw new Error("Password must contain 12–128 characters.");
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
  db.close();
}
