# Setup

## Create the resources and deploy

Run these from a checkout of the release you want. Why the region matters is in the README's [Where your data is stored](../README.md#where-your-data-is-stored).

1. **Sign in once:** `npx wrangler login`. The scripts never log in for you. If the login reaches more than one Cloudflare account, set `CLOUDFLARE_ACCOUNT_ID` to the one you want.
2. **Preview, then create** the D1 database and R2 bucket:

   ```bash
   npm run setup -- --dry-run     # prints the wrangler commands, runs none
   npm run setup                  # asks you to confirm the account, then creates
   REGION=apac npm run setup      # another region: oc (default), apac, weur, eeur, wnam, enam
   ```

   Both resources are created with `--location ${REGION:-oc}`. Re-running is safe: it creates only what is missing. It also checks that D1 read replication is off, and stops if it is not (ADR 0007).
3. **Deploy:**

   ```bash
   npm run deploy -- --dry-run    # prints the build, restore point, migration and deploy commands
   npm run deploy                 # confirms the account, then runs them
   ```

   In order, `npm run deploy` confirms the account, checks the database and bucket exist (it stops and points you at `npm run setup` rather than let Wrangler create them with no location), builds, records a D1 bookmark (restore point), applies remote migrations from `migrations/`, and deploys. It ends by printing the bookmark with rollback instructions, and prints them too if a migration or the deploy fails. Rolling back code is `npx wrangler rollback`. Restoring data is `npx wrangler d1 time-travel restore <database> --bookmark=<bookmark>`, a last resort that discards everything written since. The free plan keeps bookmarks for 7 days, and migrations are add-only so rolling back code is normally enough (ADR 0009).

Both scripts take `--yes` to skip the confirmation prompt (needed when there's no terminal). `npm run deploy` also takes `--skip-build` if `dist/` is already built.

### How resource IDs stay out of the repo

`wrangler.jsonc` gives the D1 database a `database_name` and the R2 bucket a `bucket_name`, and no `database_id`. Wrangler looks the database up by that name in the signed-in account, both for `wrangler d1 …` commands and when it deploys, so nothing needs an ID and the file in git is the file you deploy with. (Checked against Wrangler 4.148: `wrangler d1 migrations apply fernledger --remote` resolves the name through the API, and `wrangler deploy` connects a binding that has a `database_name` and no `database_id` to the existing database of that name.)

Two Wrangler behaviours the scripts guard against, because either could put IDs or the wrong location in your account:

- **Auto-provisioning** creates a missing database or bucket during `wrangler deploy` with no location hint. The deploy script checks they exist first.
- **Config write-back:** after provisioning, an interactive `wrangler deploy` may write resource IDs into `wrangler.jsonc`. The scripts run Wrangler with `CI=true`, which turns write-back off. If you run `wrangler deploy` by hand, check `git diff wrangler.jsonc` before you commit.

The script tests fail if `wrangler.jsonc` gains a `database_id` or account ID.

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
