import { createHash, randomBytes } from "node:crypto";
import { normalizeOrigin } from "./origin.js";
import { transaction } from "./database.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("hex");
const cookieValue = (req, name) =>
  (req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const invalid = (status, message) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};

export function configureSites({
  publicOrigin,
  customerOrigin,
  adminOrigin,
  production,
}) {
  if (!customerOrigin && !adminOrigin) return null;
  if (!production)
    throw new Error(
      "Separate portal domains require production mode and HTTPS. Codespaces demo uses its single forwarded address.",
    );
  const origins = [
    publicOrigin,
    normalizeOrigin(customerOrigin),
    normalizeOrigin(adminOrigin),
  ];
  if (origins.some((origin) => !origin || !origin.startsWith("https:")))
    throw new Error(
      "PUBLIC_ORIGIN, CUSTOMER_ORIGIN, and ADMIN_ORIGIN must all be exact HTTPS origins.",
    );
  if (new Set(origins).size !== 3)
    throw new Error(
      "Login, customer, and administrator origins must be different.",
    );
  const urls = origins.map((origin) => new URL(origin));
  const parent = urls[0].hostname.split(".").slice(1).join(".");
  if (
    !parent.includes(".") ||
    urls.some(
      (url) =>
        url.port || url.hostname.split(".").slice(1).join(".") !== parent,
    )
  )
    throw new Error(
      "Portal domains must be sibling HTTPS subdomains of the same domain, without custom ports.",
    );
  const [login, customer, admin] = origins;
  const root = `https://${parent}`;
  const sites = new Map([
    [new URL(login).host, { origin: login, role: "login" }],
    [new URL(customer).host, { origin: customer, role: "customer" }],
    [new URL(admin).host, { origin: admin, role: "admin" }],
    [parent, { origin: root, role: "root" }],
  ]);
  return {
    login,
    customer,
    admin,
    root,
    forRole: (role) => (role === "admin" ? admin : customer),
    forHost: (host) =>
      typeof host === "string" ? sites.get(host.toLowerCase()) : undefined,
  };
}

// A browser-bound, single-use handoff creates independent host-only sessions.
// Session credentials never appear in URLs or Domain-wide cookies.
export async function handlePortalAuth({
  req,
  res,
  path,
  site,
  sites,
  db,
  session,
  user,
  sessionCookie,
}) {
  const redirect = (location, status = 302) => {
    res.writeHead(status, {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end();
  };
  if (site.role === "root") {
    redirect(sites.login);
    return true;
  }
  if (path === "/auth/start" && req.method === "GET") {
    if (!["customer", "admin"].includes(site.role))
      invalid(404, "Page not found.");
    const state = random();
    res.setHeader(
      "Set-Cookie",
      `__Host-ledger_handoff=${state}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=120`,
    );
    redirect(
      `${sites.login}/auth/authorize?target=${site.role}&state=${state}`,
    );
    return true;
  }
  if (path === "/auth/authorize" && req.method === "GET") {
    if (site.role !== "login") invalid(404, "Page not found.");
    if (!user) {
      redirect(sites.login);
      return true;
    }
    const query = new URL(req.url, sites.login).searchParams;
    const state = query.get("state"),
      target = query.get("target");
    if (
      !/^[a-f0-9]{64}$/.test(state || "") ||
      !["customer", "admin"].includes(target)
    )
      invalid(
        400,
        "Sign-in verification failed. Start again from the login page.",
      );
    if (user.role !== target) {
      redirect(`${sites.forRole(user.role)}/auth/start`);
      return true;
    }
    const code = random(),
      destination = `${sites.forRole(user.role)}/auth/complete`;
    transaction(db, () => {
      db.prepare(
        "DELETE FROM login_handoffs WHERE expires_at<? OR login_session_hash=?",
      ).run(Date.now(), session.token_hash);
      db.prepare(
        "INSERT INTO login_handoffs(code_hash,user_id,login_session_hash,state_hash,target_origin,expires_at) VALUES(?,?,?,?,?,?)",
      ).run(
        hash(code),
        user.id,
        session.token_hash,
        hash(state),
        sites.forRole(user.role),
        Date.now() + 60000,
      );
    });
    const nonce = randomBytes(18).toString("base64");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "strict-origin",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self'; font-src 'self'; form-action ${sites.forRole(user.role)}; frame-ancestors 'none'; base-uri 'none'`,
    });
    res.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening your account · The Office of Yash SR</title><link rel="stylesheet" href="/styles.css"><main class="initial-loading"><form method="post" action="${escape(destination)}"><input type="hidden" name="code" value="${code}"><input type="hidden" name="state" value="${state}"><p>Opening your account…</p><button class="button primary" type="submit">Continue to your account</button></form></main><script nonce="${nonce}">document.querySelector('form').submit()</script></html>`,
    );
    return true;
  }
  if (path === "/auth/complete" && req.method === "POST") {
    if (
      !["customer", "admin"].includes(site.role) ||
      req.headers.origin !== sites.login ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      invalid(
        403,
        "Sign-in origin is not allowed. Start again from the login page.",
      );
    if (
      !req.headers["content-type"]?.startsWith(
        "application/x-www-form-urlencoded",
      )
    )
      invalid(415, "Invalid sign-in request.");
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 2048) invalid(413, "Sign-in request is too large.");
      chunks.push(chunk);
    }
    const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const code = body.get("code"),
      state = body.get("state"),
      browserState = cookieValue(req, "__Host-ledger_handoff");
    if (
      !/^[a-f0-9]{64}$/.test(code || "") ||
      !/^[a-f0-9]{64}$/.test(state || "") ||
      state !== browserState
    )
      invalid(
        403,
        "Sign-in verification failed. Start again from the login page.",
      );
    const ticket = db
      .prepare(
        "SELECT h.*,s.family_id FROM login_handoffs h JOIN sessions s ON s.token_hash=h.login_session_hash JOIN users u ON u.id=h.user_id WHERE h.code_hash=? AND h.state_hash=? AND h.target_origin=? AND h.expires_at>? AND s.expires_at>? AND s.user_id=h.user_id AND u.role=?",
      )
      .get(
        hash(code),
        hash(state),
        site.origin,
        Date.now(),
        Date.now(),
        site.role,
      );
    if (!ticket)
      invalid(
        403,
        "This sign-in has expired or already been used. Start again from the login page.",
      );
    const token = random();
    transaction(db, () => {
      db.prepare("DELETE FROM login_handoffs WHERE code_hash=?").run(
        ticket.code_hash,
      );
      db.prepare(
        "INSERT INTO sessions(token_hash,user_id,expires_at,family_id,audience) VALUES(?,?,?,?,?)",
      ).run(
        hash(token),
        ticket.user_id,
        Date.now() + 12 * 3600000,
        ticket.family_id || ticket.login_session_hash,
        site.origin,
      );
    });
    res.setHeader("Set-Cookie", [
      sessionCookie(token, 12 * 3600),
      "__Host-ledger_handoff=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
    ]);
    redirect(site.origin, 303);
    return true;
  }
  if (
    req.method === "GET" &&
    path === "/" &&
    site.role !== "login" &&
    (!user || user.role !== site.role)
  ) {
    redirect(sites.login);
    return true;
  }
  return false;
}
