# Setup

## Cloudflare Access (one-time, by hand)

The app has no login of its own. Cloudflare Access sits in front of it, and the Worker checks the Access token on every API request (ADR 0002).

If your Cloudflare account already has a wildcard or account-wide Access policy, for example from another project, this app still gets **its own** Access application. Access applies only the most specific matching application, so the other project's policy won't apply here.

1. **Zero Trust → Settings → Authentication → Login methods.** Make sure **One-time PIN** is enabled. Your team domain is shown under **Settings → Custom pages**, in the form `<team>.cloudflareaccess.com`.
2. **Zero Trust → Access → Applications → Add an application → Self-hosted:**
   - **Name:** Fernledger
   - **Session duration:** 24 hours
   - **Public hostname:** `fernledger.<your-subdomain>.workers.dev`, with no path.
   - **Login methods:** One-time PIN only.
3. **Policies:** create a **new** policy, and don't attach any reusable policy that already exists in the account.
   - **Name:** Fernledger Members
   - **Action:** Allow
   - **Include → Emails:** each Member's email, the Admin's included.
4. Save the application, then copy its **Application Audience (AUD) tag** from the application's overview.
5. **Test policies** (on the application): an email belonging to a Member should pass, and an email from any other project should fail.
6. Set the Worker secrets:

   ```bash
   npx wrangler secret put ACCESS_TEAM_DOMAIN   # <team>.cloudflareaccess.com
   npx wrangler secret put ACCESS_AUD           # the AUD tag from step 4
   npx wrangler secret put ADMIN_EMAIL          # the Admin's email
   ```

   Until all three are set, every API request returns 401. The app fails closed.

**Adding or removing a Member:** edit the "Fernledger Members" policy. The app needs no changes.

**Changing the Admin:** run `wrangler secret put ADMIN_EMAIL` again.

`preview_urls` is off in `wrangler.jsonc`, because version preview hostnames wouldn't match this application and would fall back to whatever wildcard policy the account has.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

Access isn't in front of the local dev server, so `DEV_USER_EMAIL` stands in for the signed-in Member. It's honoured only on `localhost`. Set it to something other than `ADMIN_EMAIL` to see the read-only view.
