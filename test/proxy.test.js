import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { buildServer } from "../server.js";
import { hashPassword } from "../lib/database.js";

const publicOrigin = "https://example-codespace-3000.app.github.dev";
const password = "ProxyTestPassword2026!";
async function fixture(options = {}) {
  const { server, db } = buildServer({
    databasePath: ":memory:",
    codespacesProxy: true,
    publicOrigin,
    production: false,
    demo: false,
    ...options,
  });
  db.prepare(
    "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,'admin')",
  ).run("Administrator", "admin@example.com", hashPassword(password));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = (cookie) =>
    fetch(`${base}/api/config`, { headers: cookie ? { Cookie: cookie } : {} });
  const login = (headers = {}) =>
    fetch(`${base}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        "Sec-Fetch-Site": "same-origin",
        ...headers,
      },
      body: JSON.stringify({ email: "admin@example.com", password }),
    });
  const close = async () => {
    server.close();
    await once(server, "close");
  };
  return { server, db, base, config, login, close };
}
async function browser(f) {
  const res = await f.config();
  return {
    Cookie: res.headers.get("set-cookie").split(";")[0],
    "X-Ledger-CSRF": (await res.json()).csrf_token,
  };
}

test("Codespaces browser verification permits rewritten or stripped Origin headers", async () => {
  const f = await fixture();
  try {
    const headers = await browser(f);
    const login = await f.login(headers);
    assert.equal(
      login.status,
      200,
      "the localhost origin forwarded by the tunnel can authenticate",
    );
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const account = await fetch(`${f.base}/api/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(account.status, 200);
    assert.equal((await account.json()).user.role, "admin");
    const stripped = await fetch(`${f.base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ email: "admin@example.com", password }),
    });
    assert.equal(
      stripped.status,
      200,
      "verification does not depend on a header removed by the proxy",
    );
  } finally {
    await f.close();
  }
});

test("rewritten-origin requests require the matching signed browser token and reject cross-site traffic", async () => {
  const f = await fixture();
  try {
    const first = await browser(f),
      second = await browser(f);
    for (const headers of [
      {},
      { Cookie: first.Cookie },
      { "X-Ledger-CSRF": first["X-Ledger-CSRF"] },
      { ...first, "X-Ledger-CSRF": "0".repeat(64) },
      { ...first, Cookie: second.Cookie },
      { ...first, "Sec-Fetch-Site": "cross-site" },
    ]) {
      assert.equal((await f.login(headers)).status, 403);
    }
    const tokenBefore = first["X-Ledger-CSRF"];
    const anotherTab = await f.config(first.Cookie);
    assert.equal(
      (await anotherTab.json()).csrf_token,
      tokenBefore,
      "opening a new tab does not invalidate the first tab",
    );
    assert.equal(
      (await f.login(first)).status,
      200,
      "invalid attempts do not invalidate a legitimate browser",
    );
  } finally {
    await f.close();
  }
});

test("browser-verification cookies are host-only and secure, and old tokens do not survive a restart", async () => {
  const first = await fixture(),
    restarted = await fixture();
  try {
    const response = await first.config();
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /^__Host-ledger_csrf=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /; Secure/);
    assert.doesNotMatch(cookie, /Domain=/i);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const token = (await response.json()).csrf_token;
    assert.equal(
      (
        await restarted.login({
          Cookie: cookie.split(";")[0],
          "X-Ledger-CSRF": token,
        })
      ).status,
      403,
    );
    assert.equal((await restarted.login(await browser(restarted))).status, 200);
  } finally {
    await first.close();
    await restarted.close();
  }
});

test("production never accepts the Codespaces token fallback", async () => {
  const f = await fixture({ production: true });
  try {
    const response = await f.config();
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal((await response.json()).csrf_token, undefined);
    assert.equal(
      (
        await f.login({
          "X-Ledger-CSRF": "a".repeat(64),
          Cookie: `ledger_csrf=${"b".repeat(64)}`,
        })
      ).status,
      403,
    );
    assert.equal((await f.login({ Origin: publicOrigin })).status, 200);
  } finally {
    await f.close();
  }
});
