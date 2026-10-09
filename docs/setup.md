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

   In PowerShell, set the variable first: `$env:REGION = "apac"; npm run setup`.

   Both resources are created with the location hint `${REGION:-oc}` (ADR 0007). Re-running is safe: it creates only what is missing, and anything that already exists keeps the location it was created with. It then checks that D1 read replication is off, and stops if Wrangler says it is on or reports nothing.
3. **Deploy:**

   ```bash
   npm run deploy -- --dry-run    # prints the build, restore point, migration and deploy commands
   npm run deploy                 # confirms the account, then runs them
   ```

   In order, `npm run deploy` confirms the account, confirms the workers.dev subdomain (below), checks the database and bucket exist (it stops and points you at `npm run setup` rather than let Wrangler create them with no location), builds, records a D1 bookmark (restore point), applies remote migrations from `migrations/`, and deploys. It ends by printing the bookmark with rollback instructions, and prints them too if a migration or the deploy fails. The printed commands start with `CLOUDFLARE_ACCOUNT_ID=<id>` so they run as printed. In PowerShell, set `$env:CLOUDFLARE_ACCOUNT_ID` first and drop the prefix. Rolling back code is `wrangler rollback`. Restoring data is `wrangler d1 time-travel restore <database> --bookmark=<bookmark>`, a last resort that discards everything written since. The free plan keeps bookmarks for 7 days, and migrations are add-only so rolling back code is normally enough (ADR 0009).

Both scripts take `--yes` to skip the account prompt (needed when there's no terminal). `npm run deploy` also takes `--workers-dev-registered` (below) and `--skip-build` if `dist/` is already built. If a script fails, it names the Wrangler command and its exit code and nothing more, because Wrangler's own output can contain your account email. Run the printed command by hand to see it.

### The workers.dev subdomain

If an account has no workers.dev subdomain, Wrangler registers one during the first deploy. In CI mode, and when it detects an AI coding agent (for example through the `CLAUDECODE` environment variable), it does so **without asking you**. Choosing the subdomain is your decision, and it's public (README: "Choosing public names"), so `npm run deploy` won't run until you've said the account has one:

- At a terminal it asks "Does this account already have a workers.dev subdomain?" and stops on anything but yes.
- With `--yes` and no terminal it stops unless you also pass `--workers-dev-registered`.

To check, open `https://dash.cloudflare.com/<account id>/workers/subdomain` (the deploy script prints the link). If none is registered, register one there first, then deploy.

### How resource IDs stay out of the repo

`wrangler.jsonc` gives the D1 database a `database_name` and the R2 bucket a `bucket_name`, and no `database_id`. Wrangler looks the database up by that name in the signed-in account, both for `wrangler d1 …` commands and when it deploys, so nothing needs an ID and the file in git is the file you deploy with. (Checked against Wrangler 4.148: `wrangler d1 migrations apply fernledger --remote` resolves the name through the API, and `wrangler deploy` connects a binding that has a `database_name` and no `database_id` to the existing database of that name.)

Two Wrangler behaviours the scripts guard against, because either could put IDs or the wrong location in your account:

- **Auto-provisioning** creates a missing database or bucket during `wrangler deploy` with no location hint. The deploy script checks they exist first.
- **Config write-back:** after provisioning, an interactive `wrangler deploy` may write resource IDs into `wrangler.jsonc`. The scripts run Wrangler with `CI=true`, which turns write-back off. If you run `wrangler deploy` by hand, check `git diff wrangler.jsonc` before you commit.

The script tests fail if `wrangler.jsonc` gains a `database_id` or account ID.

### What Wrangler answers for itself

With `CI=true` (which the scripts set) Wrangler answers its own yes/no prompts instead of asking. Checked in Wrangler 4.148's source, these are the ones that matter for the commands the scripts run, and what the scripts do about each:

| Wrangler prompt | Answer in CI mode | What the scripts do |
|---|---|---|
| "Creating a workers.dev subdomain… Ok to proceed?" | Yes, with no prompt at all when an AI coding agent is detected | Won't deploy until you've said a subdomain exists (above) |
| "Would you like to register a workers.dev subdomain now?" | No | Nothing needed |
| Deploy conflicts: Worker edited in the dashboard, uploaded by API, a secret that overrides config, a Workflows conflict | Yes, overwriting the remote | `wrangler deploy --strict`, which aborts instead |
| Provision a missing D1 database or R2 bucket during deploy | Creates it, with no location hint | Checks both exist first |
| Write resource IDs back into `wrangler.jsonc` | Skipped | Relies on `CI=true`; check `git diff wrangler.jsonc` after a manual deploy |
| "Your last deployment has multiple versions… continue?" (a gradual rollout is in progress) | Yes, replacing the rollout. `--strict` does not stop this | Nothing yet. Finish or roll back any gradual rollout in the dashboard before deploying |
| "About to apply N migration(s)… continue?" (`d1 migrations apply`) | Yes | Your account confirmation and the earlier restore point are the safeguard. The migrations applied are printed |

### Test-only environment variables

`FERNLEDGER_WRANGLER` (a stand-in for the Wrangler binary) and `FERNLEDGER_MIGRATIONS_DIR` (a stand-in for `migrations/`) exist so the script tests can run without touching Cloudflare. Don't set them for a real run.

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

The dev server shows a "Development only" bar to switch between the Admin and a read-only Member. It works by a cookie that the Worker honours only on `localhost`, and only when `DEV_USER_EMAIL` is set. Production builds don't include the bar.

**Sample data:** `npm run seed` applies the local migrations, then loads made-up data into the local database that `npm run dev` uses. It only ever touches the local database. The convention for seed files:

- Each feature that adds tables adds its own `seed/NN-name.sql`. Number it after the tables it needs (ticket 8 uses `08-accounts.sql`). Files run in filename order.
- Each file is safe to run again: `insert or replace`, or delete then insert.
- Data is made up, following the hard rules in `AGENTS.md` (bank code 99, no real names or numbers). The secret scan checks these files too.

**Browser tests:** `npm run test:e2e` builds the app and runs Playwright with axe checks in light and dark, against the production build with the real security headers. It fails on any console error or Content-Security-Policy violation. Run `npx playwright install chromium` once first, or set `PLAYWRIGHT_CHANNEL=msedge` (or `chrome`) to use a browser you already have.
