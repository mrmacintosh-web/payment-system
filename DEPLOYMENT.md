# Put the portal on payments.yashsr.com

Your domain is registered with Cloudflare. Keep it there. Use **payments.yashsr.com** for this portal so the main **yashsr.com** address can also host a separate website later.

GitHub stores your code. Codespaces runs a development copy. For customers, you need an always-on host for the Node.js server and a persistent disk for the SQLite database. Cloudflare DNS connects your domain to that host. Buying the domain does not provide the application server or an email inbox.

## Recommended path: a Linux server with Docker

The repository already includes the app, database setup, and Caddy HTTPS configuration. This path uses one Linux VPS with a permanent disk. You can choose a VPS provider such as DigitalOcean, Hetzner, or another provider supporting Docker. Hosting is a separate paid service.

1. Create a Linux VPS, install Docker Engine and the Docker Compose plugin, and note its public IPv4 address. Follow your provider's SSH instructions to connect to the server. Allow inbound TCP **80** and **443** in its firewall. Keep application port 3000 private.
2. Open **Cloudflare → yashsr.com → DNS → Records → Add record**:

   | Setting      | Value                               |
   | ------------ | ----------------------------------- |
   | Type         | A                                   |
   | Name         | payments                            |
   | IPv4 address | Your VPS's public IPv4 address      |
   | Proxy status | **DNS only** initially (gray cloud) |
   | TTL          | Auto                                |

   Do not enter the Codespaces address or GitHub repository URL. Add an AAAA record only if the server has working IPv6. Wait for `payments.yashsr.com` to resolve to your server.

3. In the VPS terminal, download the code:

   ```sh
   git clone https://github.com/mrmacintosh-web/payment-system.git
   cd payment-system
   cp .env.example .env
   nano .env
   ```

   Add this line to `.env`, then save and exit:

   ```dotenv
   DOMAIN=payments.yashsr.com
   ```

   The existing business name is already correct. Compose supplies the exact production origin, secure cookie settings, and persistent database path automatically. The other direct-Node settings in `.env.example` do not override Compose's production settings.

4. Build and create your real administrator. Replace the example email with your own address; the command prompts privately for a password of at least 12 characters.

   ```sh
   docker compose build
   docker compose run --rm app node scripts/create-admin.js you@example.com
   docker compose up -d
   ```

   This creates a fresh production database. It does not copy demonstration accounts or invoices. Do not use `npm run demo` or `npm run codespaces` for the public site.

5. Check that the site and HTTPS work:

   ```sh
   docker compose ps
   docker compose logs --tail=50 app caddy
   curl --fail https://payments.yashsr.com/api/health
   ```

   Expect `{"status":"ok","database":true}`. Caddy obtains and renews the server's HTTPS certificate. If issuance fails, verify DNS and ports 80/443 before continuing.

6. Open **https://payments.yashsr.com**, sign in, and add a customer. Share the login address and temporary password securely. Add your real receiving details under **Account → Manage payment methods**. Test with a small invoice before entering more customer records.
7. You can leave Cloudflare DNS in **DNS only** mode; Caddy already provides HTTPS. If you enable the orange proxy later, choose **SSL/TLS → Overview → Full (strict)** first. Do not use Flexible. Keep API and account responses uncached; the app sends `Cache-Control: no-store` for API data. Remove any custom **Cache Everything** rule covering this portal. Test sign-in and payment notices again after enabling the proxy.

The SQLite file and QR codes live in the persistent `billing_data` Docker volume. Rebuilding the app preserves that volume. **Do not run `docker compose down -v`**, which deletes it. Use the backup instructions in [README.md](README.md#backups-and-updates), store copies outside the server, and test that you can restore them.

## Alternative: a managed Node host

If you prefer a hosting dashboard, use a service offering **Node 24+, a persistent disk, and one always-on instance**. For example, a Render web service with a paid persistent disk can host this app. A free service with a temporary filesystem cannot safely retain this database.

1. Connect this GitHub repository as a **web service**. Use build command `npm ci --omit=dev` and start command `npm start`. Select Node 24 or newer (for hosts supporting `NODE_VERSION`, set it to `24`).
2. Attach a persistent disk at `/var/data`. Set these environment variables:

   ```dotenv
   NODE_ENV=production
   HOST=0.0.0.0
   PUBLIC_ORIGIN=https://payments.yashsr.com
   DATABASE_PATH=/var/data/billing.sqlite
   BUSINESS_NAME="The Office of Yash SR: Payment Portal"
   ```

   Use the port supplied by the host and set the health-check path to `/api/health`. Keep the service at one instance. Put the business name into dashboard fields without surrounding quotation marks.

3. Add **payments.yashsr.com** under the host's custom-domain settings. The host will give you a DNS target and any verification records. In Cloudflare, add the specified record—usually **CNAME**, name **payments**, target supplied by the host—and start with **DNS only**. Wait for the host to verify the domain and provision HTTPS. Follow the provider's record instructions if they differ.
4. Open the host's shell on the service with the persistent disk mounted. Run `npm run create-admin -- you@example.com`. The configured `DATABASE_PATH` must match the running app. Then open your custom domain to sign in. If shell access is unavailable, use a host/plan that provides it; do not create the administrator in an ephemeral build job.

The included Docker/VPS path is fully specified above; a managed host may have provider-specific disk, shell, and custom-domain requirements. **GitHub Pages and Cloudflare Pages static hosting cannot run this Node/SQLite server as-is.**

## Optional receipt and administrator emails

Dashboard receipts and payment notices work immediately, including without email. To also send email, this app supports **Resend** through its HTTPS API; it needs no additional Node packages.

1. Create a Resend account. Add a sending domain such as **yashsr.com** (or a dedicated sending subdomain) and copy the DNS verification records Resend provides into Cloudflare. Use the exact names and values from Resend. Preserve existing mail records; if you already use SPF, follow the provider's guidance rather than adding a conflicting second SPF record.
2. Wait for Resend to mark the domain verified. Create an API key allowed to send mail. A verified sending address does not create an email inbox.
3. Configure these on the production host. For Docker, edit the ignored `.env`; for managed hosting, use the service's environment/secret settings:

   ```dotenv
   RESEND_API_KEY=<your real Resend key, entered privately>
   MAIL_FROM=payments@yashsr.com
   ADMIN_EMAIL=<your real administrator email address>
   ```

   Replace the placeholders and use a sender on the domain you verified. Do not commit this file or paste the key into chat. `ADMIN_EMAIL` is optional: when omitted, notices go to the email addresses of the portal's administrator accounts. Use an actual inbox you can read.

4. Restart/redeploy the app (`docker compose up -d` for Docker). Production also needs `PUBLIC_ORIGIN=https://payments.yashsr.com`, which Compose already sets. Open **Account** as administrator to see whether delivery is configured and how many messages are queued/sent.
5. Confirm a legitimate payment. Its receipt appears immediately; the server attempts the thank-you email within about 30 seconds. When a customer reports a Venmo or Zelle payment, the administrator gets a verification notice. Check the provider's delivery dashboard and spam folder if mail does not arrive. “Sent” in the portal means the provider accepted it, not a guarantee of inbox delivery.

Email failures leave the financial record and dashboard receipt intact. Mail is queued in SQLite, retried with backoff using a stable idempotency key, and retained across restarts. After 12 failed attempts a message stays pending for operator investigation; the system does not retry it forever. Fix the provider configuration first, then an operator can reset the affected queue rows' `attempts` and `next_attempt` to zero. Do not reset sent rows. Keep restores in mind: reverting to a backup can also restore old queue state.

Only events occurring while email is configured are queued; enabling it later does not send historical receipts. **Demo mode never queues or sends email**, even if keys are present. Invitation emails, password-reset emails, and automatic reminders are not implemented.

## What the backend does

The browser calls the Node server at the same domain. The server validates sign-ins and invoice access, calculates fees and balances in integer cents, and stores invoices, schedules, payments, receiving details, receipts, and notices in SQLite. Customers can only read their own billing data. Passwords are salted hashes; sessions use HttpOnly cookies.

A customer's “I paid” action creates a declaration awaiting review. It does not contact Venmo/Zelle to check a transfer or collect money. You verify your receiving account, then confirm the notice; the server records the payment and creates the receipt together in one database transaction. For cash, use **Record payment** after receiving it. Tips remain separate from the amount applied to the invoice.

You still need to choose and provision hosting before DNS can be connected. This repository change does not create a hosting account, change Cloudflare records, or enable a live email sender.
