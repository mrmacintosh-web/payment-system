import { createInterface } from "node:readline";
import { Writable } from "node:stream";

const validate = (value) => {
  if (value.length < 12 || value.length > 128)
    throw new Error("Password must contain 12–128 characters.");
  return value;
};

export async function readNewAdminPassword({
  showPassword = false,
  input = process.stdin,
  terminalOutput = process.stdout,
  providedPassword = process.env.ADMIN_PASSWORD,
} = {}) {
  if (providedPassword && !showPassword) return validate(providedPassword);
  if (!input.isTTY)
    throw new Error(
      "Run in an interactive terminal or provide ADMIN_PASSWORD through a secure environment variable.",
    );
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (showPassword) terminalOutput.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input, output, terminal: true });
  const ask = (label) =>
    new Promise((resolve, reject) => {
      const cleanup = () => {
        rl.off("SIGINT", cancelled);
        rl.off("close", cancelled);
      };
      const cancelled = () => {
        cleanup();
        reject(new Error("Cancelled. No account or password was changed."));
      };
      rl.once("SIGINT", cancelled);
      rl.once("close", cancelled);
      terminalOutput.write(label);
      rl.question("", (value) => {
        cleanup();
        terminalOutput.write("\n");
        resolve(value);
      });
    });
  try {
    const mode = showPassword ? "visible in this terminal" : "hidden";
    const pass = validate(
      await ask(`New administrator password (12–128 characters, ${mode}): `),
    );
    const confirmation = await ask(`Repeat administrator password (${mode}): `);
    if (pass !== confirmation)
      throw new Error(
        "Passwords did not match. No account or password was changed. Run the command again.",
      );
    return pass;
  } finally {
    rl.close();
  }
}

export function adminCommandArguments(command) {
  const [email, ...flags] = process.argv.slice(2);
  const address = email?.trim().toLowerCase();
  if (
    !address ||
    address.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ||
    flags.some((flag) => flag !== "--show-password")
  )
    throw new Error(
      `Usage: npm run ${command} -- admin@example.com [--show-password]`,
    );
  return { address, showPassword: flags.includes("--show-password") };
}
