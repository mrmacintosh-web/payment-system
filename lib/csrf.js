import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function cookieValue(req, name) {
  return (req.headers.cookie || "")
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

// The HttpOnly host cookie identifies this browser. Only a same-origin script
// can read the matching HMAC token from /api/config and send the custom header.
// This does not trust Origin/Host headers rewritten by a development tunnel.
export function createCsrfProtection({ secure, lifetime }) {
  const secret = randomBytes(32);
  const name = secure ? "__Host-ledger_csrf" : "ledger_csrf";
  const valid = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const sign = (seed) =>
    createHmac("sha256", secret).update(seed).digest("hex");
  return {
    issue(req, res) {
      let seed = cookieValue(req, name);
      if (!valid(seed)) {
        seed = randomBytes(32).toString("hex");
        res.setHeader(
          "Set-Cookie",
          `${name}=${seed}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime}${secure ? "; Secure" : ""}`,
        );
      }
      return sign(seed);
    },
    verify(req) {
      const seed = cookieValue(req, name);
      const token = req.headers["x-ledger-csrf"];
      return (
        valid(seed) &&
        valid(token) &&
        timingSafeEqual(
          Buffer.from(token, "hex"),
          Buffer.from(sign(seed), "hex"),
        )
      );
    },
  };
}
