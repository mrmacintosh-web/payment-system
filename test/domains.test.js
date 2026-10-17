import { billingDate } from "../lib/billing-dates.js";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { buildServer } from "../server.js";
import { hashPassword } from "../lib/database.js";
import { configureSites } from "../lib/portal-sites.js";

const loginOrigin = "https://o.yashsr.com";
const customerOrigin = "https://secure.yashsr.com";
const adminOrigin = "https://secure-admin.yashsr.com";
const password = "DomainsTestPassword2026!";
async function fixture(options = {}) {
  const app = buildServer({
    databasePath: ":memory:",
    production: true,
    publicOrigin: loginOrigin,
    customerOrigin,
    adminOrigin,
    mail: { apiKey: "" },
    ...options,
  });
  const add = app.db.prepare(
    "INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,?)",
  );
  add.run("Office Admin", "admin@example.com", hashPassword(password), "admin");
  const customerId = Number(
    add.run(
      "Customer",
      "customer@example.com",
      hashPassword(password),
      "customer",
    ).lastInsertRowid,
  );
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(
    origin,
    path,
    { body, cookie, requestOrigin = origin, method } = {},
  ) {
    const response = await new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        `${base}${path}`,
        {
          method: method || (body === undefined ? "GET" : "POST"),
          redirect: "manual",
          headers: {
            Host: new URL(origin).host,
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body === undefined
              ? {}
              : {
                  Origin: requestOrigin,
                  "Content-Type":
                    typeof body === "string"
                      ? "application/x-www-form-urlencoded"
                      : "application/json",
                }),
          },
        },
        (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () => {
            const headers = new Headers();
            for (let index = 0; index < incoming.rawHeaders.length; index += 2)
              headers.append(
                incoming.rawHeaders[index],
                incoming.rawHeaders[index + 1],
              );
            resolve(
              new Response(Buffer.concat(chunks), {
                status: incoming.statusCode,
                headers,
              }),
            );
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.end(
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
      );
    });
    return {
      status: response.status,
      headers: response.headers,
      cookie: response.headers.getSetCookie()[0]?.split(";")[0],
      cookies: response.headers.getSetCookie(),
      location: response.headers.get("location"),
      data: response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : await response.text(),
    };
  }
  async function login(role) {
    const response = await request(loginOrigin, "/api/login", {
      body: {
        email: `${role === "admin" ? "admin" : "customer"}@example.com`,
        password,
      },
    });
    assert.equal(response.status, 200);
    return response;
  }
  async function ticket(role, loginResponse) {
    const authenticated = loginResponse || (await login(role));
    const destination = role === "admin" ? adminOrigin : customerOrigin;
    const start = await request(destination, "/auth/start");
    const url = new URL(start.location);
    const authorize = await request(loginOrigin, url.pathname + url.search, {
      cookie: authenticated.cookie,
    });
    assert.equal(authorize.status, 200, JSON.stringify(authorize.data));
    const code = authorize.data.match(/name="code" value="([a-f0-9]+)"/)[1];
    const state = authorize.data.match(/name="state" value="([a-f0-9]+)"/)[1];
    return {
      authenticated,
      destination,
      start,
      authorize,
      code,
      state,
      body: new URLSearchParams({ code, state }).toString(),
    };
  }
  async function authenticate(role) {
    const flow = await ticket(role);
    const complete = await request(flow.destination, "/auth/complete", {
      body: flow.body,
      cookie: flow.start.cookie,
      requestOrigin: loginOrigin,
    });
    assert.equal(complete.status, 303, JSON.stringify(complete.data));
    return { ...flow, complete, cookie: complete.cookie };
  }
  return {
    ...app,
    customerId,
    request,
    login,
    ticket,
    authenticate,
    close: async () => {
      app.server.close();
      await once(app.server, "close");
    },
  };
}

test("domain configuration requires three distinct sibling HTTPS origins and leaves development unchanged", () => {
  assert.equal(
    configureSites({
      publicOrigin: "http://localhost:3000",
      production: false,
    }),
    null,
  );
  const valid = {
    publicOrigin: loginOrigin,
    customerOrigin,
    adminOrigin,
    production: true,
  };
  const sites = configureSites(valid);
  assert.equal(sites.root, "https://yashsr.com");
  assert.equal(sites.forRole("admin"), adminOrigin);
  for (const change of [
    { production: false },
    { adminOrigin: undefined },
    { adminOrigin: customerOrigin },
    { customerOrigin: "http://secure.yashsr.com" },
    { adminOrigin: "https://secure-admin.other.com" },
    { customerOrigin: "https://secure.yashsr.com:8443" },
  ])
    assert.throws(() => configureSites({ ...valid, ...change }));
});

test("the apex and anonymous account pages redirect to login; only configured hosts expose the app", async () => {
  const f = await fixture();
  try {
    for (const origin of ["https://yashsr.com", customerOrigin, adminOrigin]) {
      const response = await f.request(origin, "/");
      assert.equal(response.status, 302);
      assert.equal(response.location, loginOrigin);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal((await f.request(loginOrigin, "/")).status, 200);
    assert.equal(
      (await f.request("https://attacker.example", "/")).status,
      421,
    );
    assert.equal(
      (await f.request("https://service.onrender.com", "/api/health")).status,
      200,
      "Render health checks do not depend on a custom Host",
    );
    assert.equal(
      (
        await f.request(customerOrigin, "/api/login", {
          body: { email: "customer@example.com", password },
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("login sends each role to its portal, with host-only sessions and no credentials in redirect URLs", async () => {
  const f = await fixture();
  try {
    for (const role of ["customer", "admin"]) {
      const flow = await f.authenticate(role);
      assert.equal(
        flow.authenticated.data.redirect_url,
        `${flow.destination}/auth/start`,
      );
      assert.equal(flow.complete.location, flow.destination);
      for (const value of [
        ...flow.authenticated.cookies,
        ...flow.complete.cookies,
      ]) {
        assert.match(value, /^__Host-/);
        assert.match(value, /HttpOnly/);
        assert.match(value, /SameSite=Strict/);
        assert.match(value, /Secure/);
        assert.doesNotMatch(value, /Domain=/i);
      }
      assert.equal(
        flow.authorize.headers.get("referrer-policy"),
        "strict-origin",
      );
      assert.match(
        flow.authorize.headers.get("content-security-policy"),
        /script-src 'nonce-/,
      );
      assert.equal(
        (await f.request(flow.destination, "/api/me", { cookie: flow.cookie }))
          .data.user.role,
        role,
      );
      assert.equal(
        (await f.request(flow.destination, "/", { cookie: flow.cookie }))
          .status,
        200,
      );
      assert.equal(
        (
          await f.request(flow.destination, "/api/me", {
            cookie: flow.authenticated.cookie,
          })
        ).status,
        401,
        "login session cannot be used as an account session",
      );
      assert.equal(
        (
          await f.request(loginOrigin, "/api/invoices", {
            cookie: flow.authenticated.cookie,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await f.request(loginOrigin, "/api/me", {
            cookie: flow.authenticated.cookie,
          })
        ).data.redirect_url,
        `${flow.destination}/auth/start`,
      );
    }
  } finally {
    await f.close();
  }
});

test("handoffs require the browser state, correct destination and source origin, and can only be consumed once", async () => {
  const f = await fixture();
  try {
    const flow = await f.ticket("customer");
    for (const [destination, changes] of [
      [customerOrigin, { cookie: "" }],
      [customerOrigin, { requestOrigin: "https://attacker.example" }],
      [customerOrigin, { requestOrigin: customerOrigin }],
      [adminOrigin, {}],
      [
        customerOrigin,
        {
          body: new URLSearchParams({
            code: flow.code,
            state: "a".repeat(64),
          }).toString(),
        },
      ],
    ]) {
      const response = await f.request(destination, "/auth/complete", {
        body: flow.body,
        cookie: flow.start.cookie,
        requestOrigin: loginOrigin,
        ...changes,
      });
      assert.equal(response.status, 403);
    }
    const consume = () =>
      f.request(customerOrigin, "/auth/complete", {
        body: flow.body,
        cookie: flow.start.cookie,
        requestOrigin: loginOrigin,
      });
    const results = await Promise.all([consume(), consume()]);
    assert.deepEqual(results.map((result) => result.status).sort(), [303, 403]);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM login_handoffs").get().n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("expired handoffs and revoked login sessions cannot create a portal session", async () => {
  const f = await fixture();
  try {
    let flow = await f.ticket("customer");
    f.db.prepare("UPDATE login_handoffs SET expires_at=0").run();
    assert.equal(
      (
        await f.request(customerOrigin, "/auth/complete", {
          body: flow.body,
          cookie: flow.start.cookie,
          requestOrigin: loginOrigin,
        })
      ).status,
      403,
    );
    flow = await f.ticket("customer");
    await f.request(loginOrigin, "/api/logout", {
      body: {},
      cookie: flow.authenticated.cookie,
    });
    assert.equal(
      (
        await f.request(customerOrigin, "/auth/complete", {
          body: flow.body,
          cookie: flow.start.cookie,
          requestOrigin: loginOrigin,
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("role and exact-origin checks protect admin APIs even when a cookie is copied to another host", async () => {
  const f = await fixture();
  try {
    const customer = await f.authenticate("customer"),
      admin = await f.authenticate("admin");
    assert.equal(
      (
        await f.request(adminOrigin, "/api/customers", {
          cookie: customer.cookie,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request(customerOrigin, "/api/invoices", {
          cookie: admin.cookie,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request(customerOrigin, "/api/logout", {
          body: {},
          cookie: customer.cookie,
          requestOrigin: adminOrigin,
        })
      ).status,
      403,
    );
    const token = "c".repeat(64);
    f.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,expires_at,family_id,audience) VALUES(?,?,?,?,?)",
      )
      .run(
        createHash("sha256").update(token).digest("hex"),
        f.customerId,
        Date.now() + 60000,
        "test",
        adminOrigin,
      );
    assert.equal(
      (
        await f.request(adminOrigin, "/api/customers", {
          cookie: `__Host-ledger_session=${token}`,
        })
      ).status,
      403,
      "server checks the account role independently of the cookie audience",
    );
    assert.equal(
      (await f.request(adminOrigin, "/api/customers", { cookie: admin.cookie }))
        .status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("sign-out revokes login and account sessions in that browser family without logging out another browser", async () => {
  const f = await fixture();
  try {
    const first = await f.authenticate("customer"),
      second = await f.authenticate("customer");
    const response = await f.request(customerOrigin, "/api/logout", {
      body: {},
      cookie: first.cookie,
    });
    assert.equal(response.status, 200);
    assert.equal(response.data.redirect_url, loginOrigin);
    assert.equal(
      (
        await f.request(loginOrigin, "/api/me", {
          cookie: first.authenticated.cookie,
        })
      ).status,
      401,
    );
    assert.equal(
      (await f.request(customerOrigin, "/api/me", { cookie: first.cookie }))
        .status,
      401,
    );
    assert.equal(
      (await f.request(customerOrigin, "/api/me", { cookie: second.cookie }))
        .status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("receipt email links use the customer domain and payment notices use the administrator domain", async () => {
  const sent = [];
  const f = await fixture({
    mail: {
      apiKey: "test-only",
      from: "payments@yashsr.com",
      send: async (message) => sent.push(message),
    },
  });
  try {
    const customer = await f.authenticate("customer"),
      admin = await f.authenticate("admin");
    const invoice = await f.request(adminOrigin, "/api/invoices", {
      cookie: admin.cookie,
      body: {
        customer_id: f.customerId,
        description: "Services",
        due_date: "2099-01-01",
        items: [
          { description: "Consultation", quantity: 1, unit_amount: "100.00" },
        ],
      },
    });
    assert.equal(invoice.status, 201);
    const report = await f.request(
      customerOrigin,
      `/api/invoices/${invoice.data.id}/payment-reports`,
      {
        cookie: customer.cookie,
        body: { method: "venmo", amount: "100.00", attestation: true },
      },
    );
    assert.equal(report.status, 201);
    assert.equal(
      (
        await f.request(
          adminOrigin,
          `/api/payment-reports/${report.data.id}/review`,
          {
            cookie: admin.cookie,
            body: {
              status: "confirmed",
              verified: true,
              paid_date: billingDate(),
            },
          },
        )
      ).status,
      200,
    );
    await f.flushEmail();
    assert.equal(sent.length, 5);
    const ready = sent.find((message) =>
      message.subject.startsWith("Your invoice"),
    );
    const notice = sent.find((message) => message.subject.startsWith("Verify"));
    const receipt = sent.find((message) =>
      message.subject.startsWith("Thank you"),
    );
    assert.equal(ready.recipient, "customer@example.com");
    assert.ok(ready.body.includes(customerOrigin));
    assert.equal(notice.recipient, "admin@example.com");
    assert.ok(notice.body.includes(adminOrigin));
    assert.equal(receipt.recipient, "customer@example.com");
    assert.ok(receipt.body.includes(customerOrigin));
    for (const message of sent) {
      const expected =
        message.recipient === "admin@example.com"
          ? adminOrigin
          : customerOrigin;
      const unexpected =
        message.recipient === "admin@example.com"
          ? customerOrigin
          : adminOrigin;
      assert.ok(message.body.includes(expected), message.subject);
      assert.ok(!message.body.includes(unexpected), message.subject);
    }
  } finally {
    await f.close();
  }
});
