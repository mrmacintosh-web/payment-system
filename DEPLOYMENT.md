# Deploy yashsr.com on Render, with Cloudflare DNS and Resend email

This setup uses **one paid Render web service with a persistent disk**, one SQLite database, and these addresses:

| Address                           | Behavior                                        |
| --------------------------------- | ----------------------------------------------- |
| `https://yashsr.com`              | Redirects to the login page                     |
| `https://o.yashsr.com`            | Shared login page                               |
| `https://secure.yashsr.com`       | Customer dashboard and customer pages           |
| `https://secure-admin.yashsr.com` | Administrator dashboard and administrator pages |

Cloudflare remains your registrar and DNS provider. Render runs the backend and provides HTTPS. Resend sends optional transactional email. Buying a domain does not create hosting or an email inbox.

## 1. Create the Render service

1. Sign in at [Render](https://dashboard.render.com/), choose **New → Web Service**, and connect GitHub repository `mrmacintosh-web/payment-system`.
2. Choose branch `main`, runtime **Node**, build command `npm ci --omit=dev`, and start command `npm start`. Leave the root directory blank.
3. Select a paid, always-on instance supporting persistent disks and service shell access. Use one instance, without autoscaling or previews sharing the production disk.
4. Add a persistent disk mounted at **`/var/data`** (1 GB is plenty to start if offered). The database file must live on this disk, not inside the ephemeral repository checkout.
5. Add the environment variables below. In dashboard input fields, paste the values without surrounding quotes.

   | Name              | Value                                   |
   | ----------------- | --------------------------------------- |
   | `NODE_VERSION`    | `24`                                    |
   | `NODE_ENV`        | `production`                            |
   | `HOST`            | `0.0.0.0`                               |
   | `DATABASE_PATH`   | `/var/data/billing.sqlite`              |
   | `PUBLIC_ORIGIN`   | `https://o.yashsr.com`                  |
   | `CUSTOMER_ORIGIN` | `https://secure.yashsr.com`             |
   | `ADMIN_ORIGIN`    | `https://secure-admin.yashsr.com`       |
   | `BUSINESS_NAME`   | `The Office of Yash SR: Payment Portal` |

6. Set the health-check path to **`/api/health`** in the service's advanced/settings options. Do not override Render's supplied `PORT`.
7. Create/deploy the service. When Render reports it is live, note its `.onrender.com` address. Its `/api/health` URL should return `{"status":"ok","database":true}`. The default Render hostname intentionally does not serve the account pages when the domain setup is enabled; configure the custom domains next.

The server creates the database and tables automatically. You do not need a separate Render Postgres service. A free or temporary filesystem cannot retain this SQLite database reliably.

## 2. Add all four domains and Cloudflare records

1. In the same Render service, open **Settings → Custom Domains** and add `o.yashsr.com`, `secure.yashsr.com`, `secure-admin.yashsr.com`, and `yashsr.com`. All four connect to this one service.
2. In **Cloudflare → yashsr.com → DNS → Records**, add the records Render specifies. The three subdomains normally use CNAMEs:

   | Type  | Name           | Target                                         |
   | ----- | -------------- | ---------------------------------------------- |
   | CNAME | `o`            | This service's actual `.onrender.com` hostname |
   | CNAME | `secure`       | The same Render hostname                       |
   | CNAME | `secure-admin` | The same Render hostname                       |

   Use **DNS only** (gray cloud) initially. Do not include `https://`, a path, or a slash in a CNAME target. Do not create a second conflicting record if the name already exists.

3. For the root record, name **`@`**, follow Render's apex-domain instructions. Cloudflare supports an apex CNAME through flattening if Render offers that method; otherwise use Render's stated A-record value. Do not guess a server IP. Keep the root record DNS only while verifying.
4. Back in Render, verify each domain and wait for its HTTPS certificate to become ready. All three application subdomains need HTTPS before the login handoff works.
5. Open `https://yashsr.com`: the application redirects it to `https://o.yashsr.com`. No separate Cloudflare redirect rule is needed for the root. The DNS record connects the root to Render; DNS itself does not perform an HTTP redirect.

You can leave these records DNS only: Render already terminates HTTPS. If you later enable Cloudflare proxying, set **SSL/TLS → Full (strict)**, respect the application's `Cache-Control` headers, and do not apply **Cache Everything** to the portal. Test all login and sign-out flows again after changing proxy settings. Leave existing unrelated DNS/email records intact.

## 3. Create the real administrator

1. Open the Render service's **Shell** on the deployed instance with the persistent disk mounted.
2. Run this with your actual email address:

   ```sh
   npm run create-admin -- you@example.com
   ```

3. Choose a password of 12–128 characters when prompted, then repeat it to confirm. Input is hidden by default. Append `--show-password` to display what you type in your own terminal. If an administrator was already created with an incorrect password, run `npm run reset-admin-password -- you@example.com --show-password` on the deployed service, replacing the email with the existing administrator address. This asks twice, revokes old sessions, and preserves the account and billing records. Do not put the password in command arguments, chat, source code, or a build command. The administrator and app must use the same configured `DATABASE_PATH`.
4. Sign in at **`https://o.yashsr.com`**. Your administrator account goes to **`https://secure-admin.yashsr.com`**.
5. Open **Account → Manage payment methods** and add your real receiving details. Under **Customers**, create a test customer's email and temporary password. Share these securely. That customer signs in at the same login page, lands on **`https://secure.yashsr.com`**, and must choose a new password before opening their invoices.

Do not run the demo commands on the production host. Production starts with a real database and no demonstration accounts or invoices.

## 4. Enable email with Resend

1. Create a [Resend](https://resend.com/) account. Add **yashsr.com** as a sending domain.
2. Copy Resend's exact DNS verification records into Cloudflare. The provider supplies the record types, names, and values. Verify them in Resend. Preserve existing email records; if SPF already exists, follow the provider's guidance instead of adding a conflicting second SPF record.
3. Create a Resend API key allowed to send mail. In Render's private environment settings add:

   | Name             | Value                                                                            |
   | ---------------- | -------------------------------------------------------------------------------- |
   | `RESEND_API_KEY` | Your real key, entered privately                                                 |
   | `MAIL_FROM`      | `payments@yashsr.com`, after verifying this sending domain                       |
   | `ADMIN_EMAIL`    | An inbox you actually read, including an existing Gmail/other address if desired |

4. Save and redeploy/restart the service. Open the administrator **Account** screen to confirm email delivery is configured. Without `ADMIN_EMAIL`, administrator notices go to the email addresses of the app's administrator accounts.
5. Test a new invoice and plan request using a customer account with an inbox you control. The customer receives an invoice-ready email and plan-request acknowledgment; your administrator inbox receives the plan request. Approve or decline it and check the customer's decision email. Approval includes the one-time fee and exact payment schedule. For a legitimate payment, the customer immediately gets a dashboard receipt and both parties get payment confirmation emails. The server attempts queued emails within about 30 seconds. Customer billing links point to `secure.yashsr.com`; administrator billing notices point to `secure-admin.yashsr.com`. Account-ready and password notices link to the login page, `o.yashsr.com`. Each portal requires sign-in.
6. Use Resend's delivery dashboard and the recipient's spam folder if mail does not arrive. “Sent” in the portal means the provider accepted it, not guaranteed inbox placement. The sender address does not create an inbox; a separate mailbox provider is needed to receive replies at that address.

The following events generate emails when delivery is configured:

| Event                                       | Customer / account owner                                                                      | Administrator inbox                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Customer account created                    | Account ready, login address, password shared separately                                      | -                                           |
| Invoice created                             | Invoice ready, discounted amount due, due date                                                | -                                           |
| Invoice amended                             | Reason, old/new totals, amount due, due date, updated invoice link                            | -                                           |
| Invoice deleted                             | Removal notice and reason; receipts stay available                                            | -                                           |
| Plan requested                              | Request received, pending review, quoted terms                                                | Request details and customer's note         |
| Plan approved                               | Approved terms, one-time fee, exact schedule, administrator's note                            | -                                           |
| Plan declined                               | Decision, administrator's note, current balance, next steps                                   | -                                           |
| Customer clicks “I paid” for Venmo/Zelle    | Notice received, pending review; balance unchanged                                            | Verify payment in your own account          |
| Payment notice rejected                     | Could not verify, administrator's note, balance unchanged; contact office before paying again | -                                           |
| Payment confirmed or manually recorded      | Thank-you receipt, invoice amount, tip, remaining balance                                     | Recorded payment summary and receipt number |
| Weekly late fee assessed                    | Fee amount, assessment dates, updated balance, invoice link                                   | Fee summary and invoice link                |
| Late fee waived                             | Amount removed, administrator's reason, updated balance                                       | Waiver summary and invoice link             |
| Password changed in the app                 | Security notice to the account owner                                                          | -                                           |
| Customer password reset by admin in the app | Security notice; get temporary password separately                                            | -                                           |

`ADMIN_EMAIL` overrides the recipient for all administrator billing notices. If unset, each administrator account receives them. Password security notices always go to the affected account owner. Approval and rejection actions show immediate confirmation in the administrator dashboard; they do not send an extra copy back to the reviewing administrator. Emails never include passwords or password-reset tokens. Temporary passwords must still be shared securely and separately. Command-line administrator password creation/recovery does not send email. Self-service password-reset links and automatic due/overdue reminders are not implemented.

Email failures do not undo payments or dashboard receipts. Messages are stored in SQLite alongside their billing actions and retried with backoff and stable idempotency keys. After 12 failed attempts they remain pending for operator investigation. Fix provider settings before an operator resets affected pending rows' `attempts` and `next_attempt` to zero; do not reset sent rows. Superseded/cancelled notices have `cancelled_at` set and are excluded from delivery and the portal's queued count. Only events occurring while delivery is configured are queued. Enabling email does not send historical notifications. Demo mode never queues or sends mail.

## 5. Verify and back up

New invoices have a disclosed, optional weekly late-fee policy: 2% of the discounted purchase on day four overdue, then every seven days while overdue. Approved plans use installment dates. Existing invoices stay exempt. The app checks once per minute and on startup, with a durable SQLite assessment history; keep the paid Render instance running with the same persistent disk. No separate scheduled job is needed. Pending payment verification pauses assessments. Customers and the administrator inbox receive fee and waiver notices through the same Resend settings. See [late-fee rules and waivers](README.md#weekly-late-fees) for exact calculation and review behavior.

Test the root redirect, customer and administrator sign-ins, customer password change, customer isolation, invoice plans, a Venmo/Zelle notice, administrator verification, dashboard receipt, and email. Sign-out should return to the login page and require a new sign-in. Add real customer information only after checking these workflows.

The server stores invoices, plans, payments, receiving details/QR images, receipts, and notices in `/var/data/billing.sqlite`. Keep the service at **one instance**. Follow [README backup instructions](README.md#backups-and-updates), saving to a private path on the mounted disk and copying the backup to secure storage outside the service. Back up before updates and test restoration. Do not delete the persistent disk or replace its database with a demo file.

## How sign-in crosses the subdomains

The backend uses host-only, Secure, HttpOnly cookies. A short-lived, single-use, browser-bound handoff moves sign-in from `o` to the correct role's portal, where a separate local session is created. Session credentials are not placed in redirect URLs or shared across every subdomain. Host, session audience, role, and request origin are checked on the server. Logout revokes the login and portal sessions in that browser's family.

Single-domain deployments and Codespaces continue to work without `CUSTOMER_ORIGIN` and `ADMIN_ORIGIN`. Set both to enable this domain layout; it requires production mode with sibling HTTPS subdomains. The optional Docker/VPS setup in README uses a single domain by default. For a multi-domain VPS deployment, pass both origin variables to the app and configure the reverse proxy for all four hostnames.

This code update does not provision Render, change Cloudflare DNS, or configure a live Resend sender. Complete those steps in your accounts.
