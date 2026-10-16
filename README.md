# ClearLedger billing portal

A complete website with a database for managing what customers owe. It includes separate administrator and customer logins, itemized invoices, recorded payments, and payment plan requests. The interface works on phones and desktops, and invoices can be printed or saved as PDFs.

This is an HTML/CSS/JavaScript frontend with a Node.js server and SQLite database. A domain points to the server running the app; static HTML hosting alone cannot run the database or account system.

## Try the demo

Requires **Node.js 24 or newer**. There are no third-party runtime packages or external database services.

```sh
npm ci
npm run demo
```

Open port **3000** in your development environment, or visit `http://localhost:3000` on your own computer. The login page has **Admin demo** and **Customer demo** buttons. The demo runs locally, uses `.data/demo.sqlite`, and cannot run in production. Demo credentials:

| Account       | Email            | Password        |
| ------------- | ---------------- | --------------- |
| Administrator | admin@demo.local | DemoAdmin2026!  |
| Customer      | alex@demo.local  | DemoClient2026! |

Keep demo accounts away from real billing information. Demo changes persist in the separate demo database between runs. Stop the demo before starting the real app on the same port.

## Run in GitHub Codespaces

Open this repository on GitHub, select **Code → Codespaces → Create codespace on main**, and use its terminal:

```sh
nvm install 24
nvm use 24
npm ci
npm run codespaces
```

Open **Ports → 3000 → Open in Browser**. Keep the port visibility **Private** while testing. Use **Admin demo** or **Customer demo** on the login page. Leave the terminal running; Ctrl+C stops the app.

The Codespaces command sets the exact HTTPS browser address using GitHub's environment variables, including the forwarded port. It overrides an old `PUBLIC_ORIGIN` value for this process and uses the separate demo database. The `-3000.app.github.dev` address is the website; `github.dev` is the editor.

Development tunnels can rewrite the request's Origin header to localhost. In Codespaces development mode, the app can also verify the browser using an HttpOnly host cookie and a matching HMAC token sent in a custom request header. Other websites cannot read this token, and explicit cross-site requests are still rejected. Tokens remain stable between tabs but expire when the server restarts: refresh the website after a restart. Production continues to require the configured exact origin.

If you see **Request origin is not allowed** or **Browser verification failed**, stop the running server with Ctrl+C, update using `git pull --ff-only origin main`, and run `npm run codespaces` again. Refresh the website so it obtains a new browser-verification token. Open the address printed in the terminal or use port 3000's browser button; an old tab for a different Codespace or port will not work. A custom `PORT` changes the port you need to forward and open. If startup reports that the port is already in use, stop the previous portal terminal first; do not leave an older server running on that port.

Codespaces is for development and testing. It can stop when idle, and deleting a Codespace deletes its local database. Use permanent hosting and backups for customer billing.

## Use your own data

From the repository directory:

```sh
npm ci
npm run create-admin -- you@example.com
npm start
```

The first command to create an administrator asks for a password without displaying it. Use 12–128 characters. It will not overwrite an existing account. Automation can supply `ADMIN_PASSWORD` securely through the process environment; do not put it in command arguments or commit it.

1. Sign in as the administrator. Open **Customers → Add customer** and create the customer's temporary password.
2. Share their email, portal address, and temporary password securely. Invitation and password reset emails are not sent automatically. Customers must choose a new password at first sign-in. An administrator can reset customer access from the Customers page.
3. Use **Create invoice** to choose a customer, enter the due date, and add descriptions, quantities, and prices for each individual charge. The invoice is immediately visible to that customer.
4. Customers see their own outstanding balance, due dates, line items, payment history, and plan requests. They can open an unpaid invoice and propose a monthly payment and start date.
5. Open **Plan requests** as administrator to approve or decline, with a response visible to the customer.
6. Use **Record payment** on an invoice after receiving money. The balance and paid status update immediately.

All amounts are **USD**. Quantities are whole numbers; prices support two decimal places. Plans are proposals and approvals recorded in the portal. They do not automatically change due dates, collect money, charge cards, or schedule debits. Arrange payment directly and record it as received. Online payments, email notifications, tax calculations, invoice editing/voiding, automatic reminders, and multi-business tenancy are not included.

## Connect a domain and go live

You need a domain from a registrar and a small Linux server with persistent disk storage. The included Docker Compose setup runs the portal and Caddy, which obtains and renews HTTPS certificates. Use a single app instance with its persistent SQLite volume.

1. Buy a domain (or use a subdomain such as `billing.yourbusiness.com`) and rent a Linux VPS. Install Docker Engine and the Docker Compose plugin using Docker's official instructions. Allow inbound **TCP 80 and 443** in the server/provider firewall. UDP 443 is optional. Keep port 3000 private.
2. In the domain's DNS settings, add an **A** record for your chosen hostname pointing to the VPS public IPv4 address. Add an **AAAA** record only if the server has working IPv6. Wait for DNS to resolve correctly. The examples below use `billing.yourbusiness.com`; replace it with your hostname.
3. Clone this repository onto the server and enter its directory. Create a local `.env` file with these non-secret settings:

   ```dotenv
   DOMAIN=billing.yourbusiness.com
   BUSINESS_NAME=Your Business
   ```

4. Build the app and create your real administrator account. The password prompt is interactive, and the account is saved in the persistent `billing_data` volume:

   ```sh
   docker compose build
   docker compose run --rm app node scripts/create-admin.js you@example.com
   docker compose up -d
   ```

5. Check startup and HTTPS:

   ```sh
   docker compose ps
   docker compose logs --tail=50 app caddy
   curl --fail https://billing.yourbusiness.com/api/health
   ```

   The health response must be `{"status":"ok","database":true}`. Visit your HTTPS domain, sign in, add a test customer and invoice, and verify the customer can log in and see it before entering real billing information. Do not point the public domain at the demo.

The Compose configuration sets `NODE_ENV=production`, binds the app inside Docker, supplies `PUBLIC_ORIGIN=https://your-domain`, and uses secure, HTTP-only cookies. Caddy terminates HTTPS; the app is not exposed directly. If the hostname changes, update `DOMAIN` in `.env` and run `docker compose up -d` again. No frontend rebuild is needed.

**Other hosting:** Use a host supporting Node 24+, one always-on process, and a persistent disk. Set `NODE_ENV=production`, `HOST=0.0.0.0`, `PUBLIC_ORIGIN=https://your-domain`, `BUSINESS_NAME`, and `DATABASE_PATH` to a file on that disk; run `npm start`. Use the same database path when creating the administrator. Configure HTTPS through the host and run only one app instance. Ephemeral filesystems, static-site-only hosting, and serverless functions without persistent storage are unsuitable for this SQLite setup. If developing through an HTTPS reverse proxy, set `PUBLIC_ORIGIN` to its exact origin so request-origin validation succeeds.

## Configuration

The app reads environment variables. `npm start` does not automatically load `.env`; use `node --env-file=.env server.js` when running directly. Docker Compose reads `.env` for substitution and passes the relevant variables to the app. The Docker deployment uses a fresh real database, separate from the demo.

| Variable        | Default                | Purpose                                                                           |
| --------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `HOST`          | `127.0.0.1`            | Interface to listen on                                                            |
| `PORT`          | `3000`                 | HTTP port                                                                         |
| `DATABASE_PATH` | `.data/billing.sqlite` | Persistent SQLite file                                                            |
| `BUSINESS_NAME` | `ClearLedger`          | Name shown in the portal and on invoices                                          |
| `PUBLIC_ORIGIN` | Local HTTP origin      | Exact browser origin; required HTTPS origin in production, with no trailing slash |
| `NODE_ENV`      | development            | Set `production` for public hosting                                               |

No external API keys are required. Customers can never query other customers' invoices or plan requests. Passwords use salted scrypt hashes; sessions expire after 12 hours and are stored as token hashes in SQLite. Login is throttled, state-changing requests require a matching origin, and production cookies require HTTPS. Password resets invalidate customer sessions; password changes revoke their other sessions. Login throttling is in-process and resets when the app restarts. Behind a shared reverse proxy, the IP throttle applies to failed logins across that proxy; account-based throttling also applies.

## Backups and updates

The SQLite database contains customer details, invoices, payment history, password hashes, and sessions. Keep the disk and backups private. Use the included online SQLite backup command instead of copying a live database without its WAL files:

```sh
# Direct Node installation:
npm run backup -- /secure/location/billing-backup.sqlite

# Docker installation (pick a new filename for each backup):
docker compose exec app node scripts/backup.js /app/.data/backups/billing-backup.sqlite
docker compose cp app:/app/.data/backups/billing-backup.sqlite ./billing-backup.sqlite
```

Move backups to encrypted storage outside the server and test restoration. The backup command refuses to overwrite an existing file. Back up before updating; do not run `docker compose down -v`, which deletes named volumes and their data. A restore requires stopping the app, restoring the backup to the configured database path with app-readable ownership, and removing obsolete `-wal`/`-shm` files while the app is stopped. Clear the `sessions` table in the restored database to require fresh logins. Then restart and check the health endpoint and invoice balances.

To update the Docker deployment after reviewing changes:

```sh
git pull --ff-only
docker compose up -d --build
```

## Validate changes

```sh
npm test
```

The Node test suite uses temporary databases and checks the full invoice/payment/plan lifecycle, customer isolation, amount/date validation, temporary-password rules, session revocation, CSRF protection, login throttling, production guards, and database persistence. No demo or real billing data is changed by these tests.

The application has no compilation step. For a useful manual smoke test, run the demo, open the admin view and an itemized invoice, then sign out and use the customer view to submit a plan request. Review it as administrator and verify the response in the customer's account.
