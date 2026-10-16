import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { codespacesOrigin, normalizeOrigin } from "../lib/origin.js";
import { buildServer } from "../server.js";

test("normalizes the copied browser address without permitting paths or credentials", () => {
  assert.equal(
    normalizeOrigin(" https://example.app.github.dev/ "),
    "https://example.app.github.dev",
  );
  assert.equal(
    normalizeOrigin("http://localhost:3000/"),
    "http://localhost:3000",
  );
  for (const value of [
    "https://example.com/invoice",
    "https://example.com/?token=a",
    "https://example.com/#fragment",
    "https://user:password@example.com",
    "file:///tmp/demo",
    "invalid",
  ]) {
    assert.throws(() => normalizeOrigin(value), /PUBLIC_ORIGIN/);
  }
});

test("derives one exact Codespaces origin and rejects invalid platform metadata", () => {
  const env = {
    CODESPACE_NAME: "upgraded-couscous-example123",
    GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
  };
  assert.equal(
    codespacesOrigin(env),
    "https://upgraded-couscous-example123-3000.app.github.dev",
  );
  assert.equal(
    codespacesOrigin({ ...env, PORT: "4000" }),
    "https://upgraded-couscous-example123-4000.app.github.dev",
  );
  assert.equal(
    codespacesOrigin({ CODESPACE_NAME: env.CODESPACE_NAME }),
    codespacesOrigin(env),
  );
  assert.throws(() => codespacesOrigin({}), /Codespace terminal/);
  assert.throws(
    () =>
      codespacesOrigin({
        ...env,
        GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev/path",
      }),
    /hostname/,
  );
  for (const port of ["0", "65536", "1.5", "invalid"])
    assert.throws(() => codespacesOrigin({ ...env, PORT: port }), /PORT/);
});

test("an HTTPS origin copied with its trailing slash permits the browser request", async () => {
  const publicOrigin = "https://example-codespace-3000.app.github.dev";
  const { server } = buildServer({
    production: false,
    databasePath: ":memory:",
    publicOrigin: `${publicOrigin}/`,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${server.address().port}/api/login`;
  const login = (origin) =>
    fetch(address, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        email: "missing@example.com",
        password: "NotAnAccount2026!",
      }),
    });
  try {
    assert.equal(
      (await login(publicOrigin)).status,
      401,
      "matching request reaches authentication instead of failing origin validation",
    );
    assert.equal(
      (await login("https://another-codespace-3000.app.github.dev")).status,
      403,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test(
  "Codespaces startup overrides a stale address and supports demo login while blocking other origins",
  { timeout: 15000 },
  async () => {
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    reservation.close();
    await once(reservation, "close");
    const dir = mkdtempSync(join(tmpdir(), "clearledger-codespaces-"));
    const env = {
      ...process.env,
      NODE_ENV: "development",
      CODESPACE_NAME: "upgraded-couscous-example123",
      GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
      PORT: String(port),
      PUBLIC_ORIGIN: "https://stale-address.app.github.dev",
    };
    const expectedOrigin = codespacesOrigin(env);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../scripts/codespaces.js", import.meta.url))],
      { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Codespaces startup failed: ${errors}`);
        try {
          const res = await fetch(`${base}/api/health`);
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {}
        await setTimeout(50);
      }
      assert.ok(ready, `Startup did not become ready: ${errors}`);
      assert.ok(output.includes(expectedOrigin));
      const login = (origin, extraHeaders = {}) =>
        fetch(`${base}/api/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            ...extraHeaders,
          },
          body: JSON.stringify({
            email: "admin@demo.local",
            password: "DemoAdmin2026!",
          }),
        });
      assert.equal(
        (await login(env.PUBLIC_ORIGIN)).status,
        403,
        "stale configuration is not accepted",
      );
      assert.equal(
        (await login("https://unrelated-3000.app.github.dev")).status,
        403,
        "another Codespace is not accepted",
      );
      const response = await login(expectedOrigin);
      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie").split(";")[0];
      const invoices = await fetch(`${base}/api/invoices`, {
        headers: { Cookie: cookie },
      });
      assert.equal(invoices.status, 200);
      assert.equal(
        (await invoices.json()).invoices.length,
        5,
        "the browser can authenticate and load seeded billing data",
      );
      const bootstrap = await fetch(`${base}/api/config`);
      const csrfCookie = bootstrap.headers.get("set-cookie").split(";")[0];
      const csrfToken = (await bootstrap.json()).csrf_token;
      assert.equal(
        (
          await login("http://localhost:3000", {
            Cookie: csrfCookie,
            "X-Ledger-CSRF": csrfToken,
            "Sec-Fetch-Site": "same-origin",
          })
        ).status,
        200,
        "the Codespaces command also handles a tunnel-rewritten Origin header",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
