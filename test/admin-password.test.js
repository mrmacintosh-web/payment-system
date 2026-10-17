import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, hashPassword, verifyPassword } from "../lib/database.js";
import { readNewAdminPassword } from "../lib/terminal-password.js";

const pass = "OriginalAdmin2026!",
  replacement = "ReplacementAdmin2026!";
const root = fileURLToPath(new URL("../", import.meta.url));
function promptFixture(showPassword = false) {
  const input = new PassThrough(),
    output = new PassThrough();
  input.isTTY = true;
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  const result = readNewAdminPassword({
    input,
    terminalOutput: output,
    showPassword,
    providedPassword: "",
  });
  return { input, result, text: () => text };
}

test("interactive passwords require confirmation and stay hidden by default", async () => {
  const prompt = promptFixture();
  prompt.input.write(`${replacement}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(prompt.text(), /Repeat administrator password/);
  assert.ok(!prompt.text().includes(replacement));
  prompt.input.write(`${replacement}\n`);
  assert.equal(await prompt.result, replacement);
  assert.ok(!prompt.text().includes(replacement));
});

test("visible mode echoes typed input while mismatched confirmation and cancellation fail safely", async () => {
  const shown = promptFixture(true);
  shown.input.write(`${replacement}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(shown.text().includes(replacement));
  const mismatch = assert.rejects(shown.result, /Passwords did not match/);
  shown.input.write("DifferentAdmin2026!\n");
  await mismatch;
  const cancelled = promptFixture();
  const cancellation = assert.rejects(cancelled.result, /Cancelled/);
  cancelled.input.write("\x03");
  await cancellation;
});

test("reset changes only the selected admin password, revokes its sessions, and preserves invoices and other accounts", () => {
  const dir = mkdtempSync(join(tmpdir(), "admin-password-")),
    path = join(dir, "billing.sqlite");
  let db;
  const run = (script, address, extra = {}) =>
    spawnSync(process.execPath, [join(root, "scripts", script), address], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_PATH: path,
        ADMIN_PASSWORD: replacement,
        ...extra,
      },
    });
  try {
    db = openDatabase(path);
    const add = db.prepare(
      "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,?)",
    );
    add.run("Owner", "owner@example.com", hashPassword(pass), "admin");
    add.run("Other Admin", "other@example.com", hashPassword(pass), "admin");
    add.run("Customer", "customer@example.com", hashPassword(pass), "customer");
    db.exec(`
      INSERT INTO invoices(id,customer_id,number,description,issued_date,due_date) VALUES(1,3,'INV-OLD','Preserve this','2026-01-01','2026-02-01');
      INSERT INTO line_items(invoice_id,description,quantity,unit_amount) VALUES(1,'Services',1,10000);
      INSERT INTO payments(invoice_id,amount,paid_date,recorded_by) VALUES(1,2500,'2026-01-15',1);
      INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('owner-token',1,9999999999999),('other-token',2,9999999999999);
      INSERT INTO login_handoffs(code_hash,user_id,login_session_hash,state_hash,target_origin,expires_at) VALUES('unused-code',1,'owner-token','state','https://secure-admin.yashsr.com',9999999999999);
    `);
    const billingBefore = JSON.stringify([
      db.prepare("SELECT * FROM invoices").all(),
      db.prepare("SELECT * FROM payments").all(),
    ]);
    const result = run("reset-admin-password.js", "OWNER@example.com");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /password updated/);
    assert.ok(!result.stdout.includes(replacement));
    const owner = db.prepare("SELECT * FROM users WHERE id=1").get();
    assert.ok(verifyPassword(replacement, owner.password_hash));
    assert.equal(verifyPassword(pass, owner.password_hash), false);
    assert.equal(owner.full_name, "Owner");
    assert.ok(
      verifyPassword(
        pass,
        db.prepare("SELECT password_hash FROM users WHERE id=2").get()
          .password_hash,
      ),
    );
    assert.ok(
      verifyPassword(
        pass,
        db.prepare("SELECT password_hash FROM users WHERE id=3").get()
          .password_hash,
      ),
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id=1").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id=2").get().n,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM login_handoffs").get().n,
      0,
    );
    assert.equal(
      JSON.stringify([
        db.prepare("SELECT * FROM invoices").all(),
        db.prepare("SELECT * FROM payments").all(),
      ]),
      billingBefore,
    );
    for (const address of ["customer@example.com", "missing@example.com"])
      assert.equal(run("reset-admin-password.js", address).status, 1);
    assert.equal(
      run("reset-admin-password.js", "owner@example.com", {
        ADMIN_PASSWORD: "short",
      }).status,
      1,
    );
    assert.equal(
      run("create-admin.js", "owner@example.com").status,
      1,
      "creation never overwrites an existing account",
    );
    assert.ok(
      verifyPassword(
        replacement,
        db.prepare("SELECT password_hash FROM users WHERE id=1").get()
          .password_hash,
      ),
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
