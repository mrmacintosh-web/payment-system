import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve(process.env.DATABASE_PATH || ".data/billing.sqlite");
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || output === source || existsSync(output)) {
  console.error(
    "Usage: npm run backup -- /path/to/a-new-backup.sqlite (must be a new file, separate from the database)",
  );
  process.exit(1);
}
if (!existsSync(source)) {
  console.error(
    "Database not found. Set DATABASE_PATH to the existing billing database.",
  );
  process.exit(1);
}
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, output);
  chmodSync(output, 0o600);
  console.log("Database backup completed. Keep the backup in secure storage.");
} finally {
  db.close();
}
