# The Office of Yash SR: Payment Portal

A complete website with a database for managing what customers owe. It includes separate administrator and customer logins, itemized invoices, recorded payments, and payment plan requests. The interface works on phones and desktops, and invoices can be printed or saved as PDFs.

The portal uses the Office's gold wordmark and a warm cream **Soft display** by default, with a charcoal theme available through the display toggle, and locally hosted Glacial Indifference typography. Customers arrive at a focused **Total due** screen; invoices, payment plans, and account settings are available from the top menu. The same branding appears on sign-in, invoices, and the browser favicon. The font's SIL Open Font License is bundled in `public/fonts/OFL.txt`.

**For yashsr.com on Render:** follow [the hosting, domain, and email setup guide](DEPLOYMENT.md). The root redirects to `o.yashsr.com` for login, customers use `secure.yashsr.com`, and administrators use `secure-admin.yashsr.com`. It covers hosting, DNS, HTTPS, backups, and optional email.

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

The first command asks for a password and then asks you to repeat it. Use 12–128 characters. Input is hidden by default; a mismatch cancels creation. To see what you type in your own terminal, use `npm run create-admin -- you@example.com --show-password`. Creation never overwrites an existing account. Automation can supply `ADMIN_PASSWORD` securely through the process environment; do not put it in command arguments or commit it. `--show-password` explicitly uses interactive input even if that variable is present.

If an administrator password was mistyped or forgotten, use the hosting service's shell on the instance with the database disk mounted:

```sh
npm run reset-admin-password -- you@example.com
# Optional visible input, still confirmed twice:
npm run reset-admin-password -- you@example.com --show-password
```

Replace the email with the existing administrator's address. Keep `DATABASE_PATH` the same as the running app. The reset changes only that administrator's password, signs out their existing sessions, and preserves customer accounts, invoices, and payments. It refuses missing or customer accounts. Visible input appears in that terminal, so use it only where you are comfortable displaying the password. If a deployed service says the npm script is missing, deploy the latest `main` commit and reopen its shell first.

1. Sign in as the administrator. Open **Customers → Add customer** and create the customer's temporary password.
2. Share their email, portal address, and temporary password securely. Invitation and password reset emails are not sent automatically. Customers must choose a new password at first sign-in. An administrator can reset customer access from the Customers page.
3. Use **Create invoice** to choose a customer, enter the due date, and add descriptions, quantities, and prices for each individual charge. Add an optional **Discount amount ($)** and label such as “Holiday sale” to subtract a dollar amount from the charges. The invoice is immediately visible to that customer.
4. Customers see their own outstanding balance, due dates, line items, payment history, and plan requests. They can open an unpaid invoice and request an eligible fixed-term plan, with the fee and installments shown before consent.
5. Open **Plan requests** as administrator to approve or decline, with a response visible to the customer.
6. Use **Record payment** on an invoice after receiving money. Enter the amount applied to the invoice, any tip received separately, and the payment method. The balance and paid status update immediately, and a permanent receipt appears under **Receipts** in the customer dashboard. Tips appear in payment history but do not reduce the amount owed on the invoice.

All amounts are **USD**. Quantities are whole numbers; prices support two decimal places. A discount cannot exceed the charges subtotal; a fully discounted invoice has no balance due. Plans are requests reviewed by the administrator. Approval of a new fixed-term plan adds its disclosed one-time fee and a dated installment schedule. The original invoice due date stays visible. Plans do not collect money, charge cards, or schedule debits. Arrange payment directly and record it as received. Automatic payment processing, tax calculations, invoice editing/voiding, automatic reminders, and multi-business tenancy are not included.

## Pay-in-full invoices and monthly plans

On **Create invoice → Payment options**, choose **Pay in full only** or **Allow eligible 3- or 6-month plans** (the default for new invoices).

| Purchase total after discounts | Available plans                             |
| ------------------------------ | ------------------------------------------- |
| Below $50                      | Pay in full                                 |
| $50–$249.99                    | 3 months with a one-time 2.25% fee          |
| $250 or more                   | 3 months with 2.25%, or 6 months with 4.55% |

The fee is calculated once on the **entire discounted purchase**, excluding tips, even if part of the purchase has already been paid. It is rounded to the nearest cent, with half cents rounded up. It is not a monthly or compounded charge. For example, a $250 purchase on six months has an $11.38 fee and $261.38 total: five $43.56 installments and one final $43.58 installment. Rounding is allocated to the final payment so the schedule sums exactly.

Customers see the fee, total, and installments and must consent before submitting. **Requests do not add fees.** Approval adds the fee once and creates the schedule; declining does not. A balance change after a request requires declining and requesting a new quote. Month-end dates clamp to the last day of short months and then return to the original day in later months. Payments apply to installments in order; tips do not affect installment balances. After approval the payment screen prefills the next unpaid installment, and customers can also pay extra or the full balance.

Pay-in-full invoices reject plan requests and partial payments on the server. For other invoices, an administrator can still record an actual partial payment received. Existing invoices and older custom plans retain their original behavior and balances; no new fee is added to old approvals. These new policy choices apply when creating new invoices.

## Receipts and payment verification

Every newly recorded payment creates an immutable receipt, including the customer, itemized charges, discount, plan fee, payment method, invoice amount, tip, and balance **at the time of that payment**. Customers can open **Receipts** from the top menu or dashboard, then **Print / Save PDF**. Partial payments also receive receipts. Earlier receipts do not change when later payments are recorded. Historical payments are preserved without generating retroactive receipts or emails.

After sending money, a customer can choose **I paid with Venmo/Zelle**, enter a reference, and confirm that they actually sent the payment. This creates a notice under the administrator's **Payment notices** menu; it does not mark the invoice paid. Only one notice per invoice can await review. The administrator checks the receiving account, then confirms the exact amount and date or rejects with a response. Confirmation records the payment and receipt together. Repeated confirmation cannot record it twice. While a notice is pending, direct manual recording is blocked to avoid counting the same money again; review the notice first.

Optional thank-you emails and administrator payment notices use Resend. They require a verified sender, `RESEND_API_KEY`, `MAIL_FROM`, and a production HTTPS `PUBLIC_ORIGIN`. See [email setup](DEPLOYMENT.md#4-enable-email-with-resend). Portal receipts work without email, and demo mode never sends mail.

## Display options

**Soft display: On** is the default, with warm cream surfaces, darker text, muted gold accents, and no animations, glow, or backdrop blur. Use the persistent button to switch to the original dark palette. The preference is saved in this browser when local storage is available. Glacial Indifference and the Office logo remain in both modes.

## Cash, Venmo, Zelle, and optional tips

As administrator, open **Account → Manage payment methods**. Add your cash payment instructions, Venmo username, Zelle phone number or email, and each service's actual QR image. PNG, JPEG, and WebP images up to **1 MB each** are supported. You can add these later, replace an image, or remove one. Empty file inputs preserve previously saved codes. These receiving details are shown only to signed-in users and are stored in the database with your billing data, so database backups include them. No payment API keys are needed.

Customers open an unpaid invoice and choose **Make a payment**. They can select no tip, a preset dollar tip, or enter another tip amount, then choose:

- **Cash:** the total to pay in person, including the selected optional tip, and your cash instructions.
- **Venmo:** the total to send, your username, QR image, and invoice reference.
- **Zelle:** the total to send, your number/email, QR image, and invoice reference.

Unconfigured details show a clear placeholder; no real recipient or working QR code is invented. Customers send money in their own app or pay you in person. Selecting a method or tip does **not** send money, change the invoice debt, or mark it paid. Verify receipt, then record the invoice portion and tip separately. For example, if $80 is owed and you receive $90 including a $10 tip, record **Amount toward invoice: $80** and **Tip received: $10**. The invoice is paid and the $10 gratuity remains separately visible. The administrator's Payments received summary includes both recorded invoice payments and tips.

Existing databases upgrade automatically on startup with additive columns and tables for discounts, tips, policies, schedules, receipts, notices, and the optional email outbox. Existing balances and payment history are retained. Back up production data before updating.

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

| Variable          | Default                                 | Purpose                                                                           |
| ----------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| `HOST`            | `127.0.0.1`                             | Interface to listen on                                                            |
| `PORT`            | `3000`                                  | HTTP port                                                                         |
| `DATABASE_PATH`   | `.data/billing.sqlite`                  | Persistent SQLite file                                                            |
| `BUSINESS_NAME`   | `The Office of Yash SR: Payment Portal` | Name shown in the portal and on invoices                                          |
| `PUBLIC_ORIGIN`   | Local HTTP origin                       | Exact browser origin; required HTTPS origin in production, with no trailing slash |
| `CUSTOMER_ORIGIN` | unset                                   | Optional customer HTTPS origin; set with ADMIN_ORIGIN for separate role domains   |
| `ADMIN_ORIGIN`    | unset                                   | Optional administrator HTTPS origin; see DEPLOYMENT.md                            |
| `NODE_ENV`        | development                             | Set `production` for public hosting                                               |
| `RESEND_API_KEY`  | unset                                   | Optional private Resend send-mail API key                                         |
| `MAIL_FROM`       | unset                                   | Verified sender email for optional notifications                                  |
| `ADMIN_EMAIL`     | administrator account emails            | Optional inbox override for payment notices                                       |

No external API keys are required for the portal. Optional email delivery requires a Resend key; see [DEPLOYMENT.md](DEPLOYMENT.md#4-enable-email-with-resend). Customers can never query other customers' invoices or plan requests. Passwords use salted scrypt hashes; sessions expire after 12 hours and are stored as token hashes in SQLite. Login is throttled, state-changing requests require a matching origin, and production cookies require HTTPS. Password resets invalidate customer sessions; password changes revoke their other sessions. Login throttling is in-process and resets when the app restarts. Behind a shared reverse proxy, the IP throttle applies to failed logins across that proxy; account-based throttling also applies.

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
