const invalid = (message) => {
  const error = new Error(message);
  error.status = 400;
  throw error;
};
const MAX_QR_BYTES = 1024 * 1024;
const fields = [
  "cash_instructions",
  "venmo_username",
  "zelle_number",
  "venmo_qr",
  "zelle_qr",
];

export function getPaymentSettings(db) {
  return {
    ...db
      .prepare(
        "SELECT cash_instructions,venmo_username,zelle_number,venmo_qr,zelle_qr FROM payment_settings WHERE id=1",
      )
      .get(),
  };
}

function qrImage(value) {
  if (value === "") return value;
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(MAX_QR_BYTES / 3) * 4 + 64
  )
    invalid("QR images must be PNG, JPEG, or WebP files up to 1 MB.");
  const match = value.match(
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  if (!match) invalid("Upload a PNG, JPEG, or WebP QR image.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_QR_BYTES || bytes.toString("base64") !== match[2])
    invalid("QR images must be valid files up to 1 MB.");
  const valid =
    match[1] === "png"
      ? bytes.length >= 33 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.toString("ascii", 12, 16) === "IHDR" &&
        bytes.readUInt32BE(16) > 0 &&
        bytes.readUInt32BE(20) > 0 &&
        bytes.readUInt32BE(16) <= 8192 &&
        bytes.readUInt32BE(20) <= 8192
      : match[1] === "jpeg"
        ? bytes.length >= 4 &&
          bytes[0] === 255 &&
          bytes[1] === 216 &&
          bytes[2] === 255
        : bytes.length >= 16 &&
          bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid)
    invalid(
      "This file does not match its image type. Upload a valid PNG, JPEG, or WebP image.",
    );
  return value;
}

export function savePaymentSettings(db, body) {
  const next = getPaymentSettings(db);
  for (const field of fields) {
    if (!Object.hasOwn(body, field)) continue;
    if (field.endsWith("_qr")) {
      next[field] = qrImage(body[field]);
      continue;
    }
    if (
      typeof body[field] !== "string" ||
      body[field].trim().length > (field === "cash_instructions" ? 1500 : 120)
    )
      invalid("Enter valid payment instructions and contact details.");
    next[field] = body[field].trim();
  }
  next.venmo_username = next.venmo_username.replace(/^@/, "");
  if (next.venmo_username && !/^[a-z\d_.-]{1,80}$/i.test(next.venmo_username))
    invalid("Enter the Venmo username, without a URL or spaces.");
  const digits = next.zelle_number.replace(/\D/g, "");
  const phone =
    /^[+\d()\s.-]{7,40}$/.test(next.zelle_number) &&
    digits.length >= 7 &&
    digits.length <= 15;
  if (
    next.zelle_number &&
    !phone &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.zelle_number)
  )
    invalid("Enter the Zelle phone number or email address.");
  db.prepare(
    "UPDATE payment_settings SET cash_instructions=?,venmo_username=?,zelle_number=?,venmo_qr=?,zelle_qr=? WHERE id=1",
  ).run(...fields.map((field) => next[field]));
  return next;
}
