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
   npm run deploy -- --dry-run    # prints the build, restore point, migration and deploy commands, and describes the backup
   npm run deploy                 # confirms the account, then runs them
   ```

   In order, `npm run deploy` confirms the account, confirms the workers.dev subdomain (below), checks the database and bucket exist (it stops and points you at `npm run setup` rather than let Wrangler create them with no location), builds, takes a complete backup ([below](#the-backup-before-a-deploy)), records a D1 bookmark (restore point), applies remote migrations from `migrations/`, deploys, and sets the key for the Members' read counts if the Worker has none ([below](#the-key-for-the-members-read-counts)). **If the backup fails it stops there, with nothing changed.** It ends by printing the bookmark with rollback instructions, and prints them too if a migration or the deploy fails. The printed commands start with `CLOUDFLARE_ACCOUNT_ID=<id>` so they run as printed. In PowerShell, set `$env:CLOUDFLARE_ACCOUNT_ID` first and drop the prefix. [Rolling back](#rolling-back) covers what to do with them.

Every script takes `--yes` to skip the account prompt (needed when there's no terminal). `npm run deploy` also takes `--workers-dev-registered` (below), `--skip-build` if `dist/` is already built, and `--skip-backup` (only after you've made a copy by hand). If a script fails, it names the Wrangler command and its exit code and nothing more, because Wrangler's own output can contain your account email. Run the printed command by hand to see it.

### The workers.dev subdomain

If an account has no workers.dev subdomain, Wrangler registers one during the first deploy. In CI mode, and when it detects an AI coding agent (for example through the `CLAUDECODE` environment variable), it does so **without asking you**. Choosing the subdomain is your decision, and it's public (README: "Choosing public names"), so `npm run deploy` won't run until you've said the account has one:

- At a terminal it asks "Does this account already have a workers.dev subdomain?" and stops on anything but yes.
- With `--yes` and no terminal it stops unless you also pass `--workers-dev-registered`.

To check, open `https://dash.cloudflare.com/<account id>/workers/subdomain` (the deploy script prints the link). If none is registered, register one there first, then deploy.

### The key for the Members' read counts

The Members' daily read limit keeps each Member's count under a code worked out from the day and their email address (`worker/member-read-limit.ts`). With only those two, someone holding a backup could try the household's few email addresses and tell whose count is whose. So the code also uses a key, the Worker secret `MEMBER_KEY_SECRET`, which is kept outside the database and so is in no backup.

You never choose, see or type it. After deploying, `npm run deploy` checks whether the Worker has it and, if not, makes a random one and gives it to Wrangler on its input, never on a command line or in a file. It never replaces one that is there. Until it is set (a Worker deployed some other way, or a deploy that couldn't set it, which says so), the counts are kept under the code without the key, as before, and Settings says Setup needed. Running `npm run deploy` again sets it.

**To change the key:** `npx wrangler secret delete MEMBER_KEY_SECRET`, then `npm run deploy`. Nothing else needs to change: that day's counts start again under the new key, so each Member could read up to about twice the daily limit that day.

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
| "About to apply N migration(s)… continue?" (`d1 migrations apply`) | Yes | Your account confirmation, the backup and the restore point before it are the safeguard. The migrations applied are printed |
| "Delete this database?" (`d1 delete`) | Yes | `npm run teardown` passes `--skip-confirmation` itself, and only after you type the database name ([Leaving Fernledger](#leaving-fernledger-teardown)) |

### Test-only environment variables

`FERNLEDGER_WRANGLER` (a stand-in for the Wrangler binary) and `FERNLEDGER_MIGRATIONS_DIR` (a stand-in for `migrations/`) exist so the script tests can run without touching Cloudflare. Don't set them for a real run.

## Backups and restore

The Worker backs up every table to your R2 bucket (`BACKUPS` in `wrangler.jsonc`) on the weekly cron (Sunday 16:00 UTC), under `backups/<NZ date>/`. README ("Recoverable") says what that protects. Nothing deletes a backup; to remove old ones, delete them in the R2 dashboard.

- `manifest.json` lists each table with its row count and CREATE statement, and each part's object key, size and SHA-256 checksum. **A backup exists only once its manifest does**; the restore script and you should ignore a folder without one.
- Each table is split into `<table>.<n>.ndjson` parts of up to 1000 rows and 256 KB, one JSON object per row.
- Tables come from the database's own schema, so a table added by a later release is backed up with no change to the backup code. The exceptions are tables that can't be read page by page by rowid: `WITHOUT ROWID` tables, virtual (for example full-text search) tables and their internal shadow tables. These are **not copied**; the manifest's `skipped` list names each with the reason, and the restore script prints it. Fernledger's own tables are ordinary tables. A future table of one of those kinds will need backup support added with it.
- A backup refuses (and logs `backup.failed` with `BackupFormatError`) a number JSON can't hold exactly: a whole number above 2^53 or infinity. Money is whole cents, far below that.
- A run on a date that already has a manifest is skipped, never overwritten.

**How a run fits the Free plan (ADR 0004).** One invocation gets 10 ms of CPU and 50 subrequests, so it can write only about 1 MB of backup (and at most 40 D1 and R2 operations on the weekly cron, 20 on a continuation). A run saves its place after every part and carries on in the Worker's 15:00 UTC cron invocations (the 13:30 one is Sync's alone) until it finishes. That gives roughly 8 MB of backup a week, about **20,000 to 25,000 Transactions** at around 300 bytes each, with the rest of the database counted in. A database that size or smaller finishes within the week, usually within a few days.

Past that, a run can't finish before the next Sunday. The next Sunday then marks it abandoned (`incomplete.json` in its folder, a `backup.abandoned` log line with the row count, and a note in the next manifest) and starts again, so backups stop completing. Watch the Worker logs for `backup.abandoned`. If you get there, take a manual copy instead: `npx wrangler d1 export <database> --remote --output backup.sql`. D1's own restore point (above) covers the last 7 days.

A run longer than one invocation is a rolling copy, not a single point in time: a row edited while it is under way may be captured either side of the edit. For a point-in-time copy use the D1 restore point that `npm run deploy` records.

### The backup before a deploy

`npm run deploy` doesn't wait for the Sunday cron. It runs the Worker's own backup code (`worker/backup.ts`) on your machine, with the database and bucket reached through Wrangler, so the backup has the same layout and manifest as a cron one and `npm run restore` reads it the same way. It then waits for the manifest, which is what makes a backup exist.

- **It stops the deploy if it can't finish.** Nothing has been changed at that point. Run `npm run deploy` again: an unfinished run carries on from where it stopped.
- **A first deploy has nothing to back up.** A database with no tables is skipped, and the script says so.
- **A complete backup for today's NZ date is reused**, never overwritten, so deploying twice in a day backs up once. Rows written since that backup aren't in it, and the script says so. The restore point recorded right after covers them. (The teardown never reuses a backup: [below](#leaving-fernledger-teardown).)
- **`--dry-run` doesn't list the backup's commands.** A backup is hundreds of Wrangler calls, so a dry run describes it in one line and prints the rest.
- **`--skip-backup`** deploys without one. Make a copy first: `npx wrangler d1 export <database> --remote --output backup.sql`.
- It calls Wrangler many times for a large database, so it can take a few minutes. It prints progress, and keeps your data only in a temporary folder that it removes at the end.

### Rolling back

README ("Recoverable") says what each layer protects. In order of how much each costs you:

1. **Code only (the usual fix).** Migrations only add (ADR 0009), so the previous release still runs on the newer schema. Redeploy it: check out the previous release's tag (`git checkout <tag>`, then `npm install`) and run `npm run deploy`, or run `npx wrangler rollback` to put back the previous deployed version. Either leaves your data as it is. Cloudflare's documentation doesn't say whether a rollback to a version from before the [key for the Members' read counts](#the-key-for-the-members-read-counts) was set keeps it. If Settings says Setup needed for it afterwards, the next `npm run deploy` sets a new one. `npm run deploy` prints the commands, with your account ID in them.
2. **Data, within 7 days: the restore point.** If the migration or the release damaged data, restore the D1 bookmark that `npm run deploy` printed (just before the migrations):

   ```bash
   CLOUDFLARE_ACCOUNT_ID=<account id> npx wrangler d1 time-travel restore <database> --bookmark=<bookmark>
   ```

   In PowerShell, set `$env:CLOUDFLARE_ACCOUNT_ID` first and drop the prefix. This puts the database back as it was at the bookmark and **discards everything written since**, so redeploy the previous release as well (step 1) rather than leave new code on old data. The free plan keeps restore points for 7 days. If you lost the bookmark, `npx wrangler d1 time-travel info <database>` shows the current one, and `--timestamp=<time>` restores to a moment instead.
3. **Data, older than that: the backup.** The deploy's backup is in the bucket under `backups/<NZ date>/` (the deploy printed its folder; [Restoring](#restoring) says where else to find dates). A restore only adds rows to an **empty** database that already has the schema, so it can't be loaded into the live one. Restore into a new database and point the app at it. Rehearse that first ([practice run](#restore-practice-run-twice-a-year)).
   1. In `wrangler.jsonc`, change the D1 binding's `database_name` to a new name, for example `fernledger-restored`. Keep this edit in your checkout and don't commit it: the repo is public, and every later `npm run deploy` needs the same name.
   2. `npm run setup` creates the new empty database, with the location hint (it leaves the bucket alone).
   3. `npx wrangler d1 migrations apply <new name> --remote` gives it the schema.
   4. `npm run restore -- <backup date> --dry-run`, then `npm run restore -- <backup date>`, loads the backup into it (it restores into the database named in `wrangler.jsonc`) and compares the row counts with the manifest.
   5. `npm run deploy` redeploys the Worker bound to the new database. Delete the old one with `npx wrangler d1 delete <old name>` once you are satisfied.

After any rollback, check the row counts and open the app before you call it fixed.

### Restoring

Restore into an **empty** database that has the schema. A restore adds rows and never overwrites, and it refuses a database that already has rows in any backed-up table or lacks a backed-up column (a database with extra columns, from a newer schema, is fine). The one exception is the starter Categories that the migrations add: if nothing else has rows, the restore replaces them with the backup's Categories (it deletes the starter rows first, which is safe only because every other table is empty, so nothing can refer to them). A backup made before Category kinds ([ADR 0012](adr/0012-spending-and-category-kinds.md)) has no kind to restore, so every Category comes back as Spending until the Admin sets the Income and Loans ones again.

**Finding the `<backup date>`:** open the Cloudflare dashboard, R2, your backup bucket, `backups/`. Each folder is an NZ date, `YYYY-MM-DD`, and counts only if it holds a `manifest.json`. The weekly backup runs on Sundays, and `npm run deploy` prints the folder of the one it took. The newest date with a manifest is the latest backup. A folder ending `-final-<time>` is the final backup `npm run teardown` took. It restores like any other: pass its whole folder name, e.g. `2026-10-12-final-20261012T031500123Z`. (Wrangler can't list a bucket, so the script can't list them for you.)

```bash
npm run restore -- 2026-10-12 --dry-run   # downloads and verifies the backup, checks the target, prints the loads; writes nothing
npm run restore -- 2026-10-12             # confirms the account, then restores
```

It downloads the manifest and every part (only the manifest and parts under that date's folder), checks each one's size, checksum and row count, checks the database has every backed-up table and column, and only then loads the database, one `wrangler d1 execute --file` per part. It ends by counting the rows in each table and comparing them with the manifest. `--dry-run` does all of that except the load, so it needs your account (it only reads) and shows the commands it would run. Add `--yes` to skip the account prompt, `--database <name>` to restore into a different database, and `--local` to use Wrangler's local dev storage instead of your account.

If a load fails part-way, the database holds some of the rows: empty it (or create a fresh one and apply the migrations) and run the restore again.

### Restore practice run, twice a year

A backup you have never restored is a guess. Twice a year (say April and October), restore the latest backup (find its date as above) into a scratch database, check the row counts the script prints against the manifest, then delete the scratch database. It touches nothing live:

```bash
npx wrangler d1 create fernledger-practice --location oc
npx wrangler d1 execute fernledger-practice --remote --file migrations/<file>.sql   # each file in migrations/, in order
npm run restore -- <backup date> --database fernledger-practice
```

```bash
npx wrangler d1 delete fernledger-practice   # the scratch database; Wrangler asks you to confirm
```

The run passes if the restore ends with every count matching the manifest, and a table's `.ndjson` shows real rows. If it fails, treat your backups as unproven: take a manual copy (`npx wrangler d1 export`) and open an issue, without any of your data in it.

CI runs the round trip (seed, back up with the Worker's own code, restore with this script, compare) on a local SQLite database, and never touches a Cloudflare account.

## Leaving Fernledger (teardown)

README ("Leaving Fernledger") says what this does and why. It is deliberately hard to do by accident.

```bash
npm run teardown -- --dry-run            # prints every step and command, runs none
npm run teardown -- --out ~/fernledger-final-backup
```

In order, `npm run teardown`:

1. **Confirms the account**, as the other scripts do.
2. **Takes a final backup.** It runs a new complete backup of the database with the Worker's backup code, **never reusing** one already in the bucket (an older one would miss later writes). It goes in a folder of its own, `backups/<NZ date>-final-<time>/`. You can restore from it like any other backup, by passing that folder name to `npm run restore`. It then downloads the manifest and every part, and checks each against the manifest's size and checksum. They are saved in the `--out` folder (default `fernledger-final-backup-<date>` in your home folder), which must be new or empty and **outside this repository, which is public**. Keep the folder somewhere private: it holds every Transaction.
3. **Checks the backup is all of the database.** It counts the rows in each table now and compares them with the manifest, and looks for tables the manifest doesn't list. If anything differs (Sync or an Import wrote while the backup ran), it deletes nothing. Stop whatever writes to the database and run it again. This checks every table and its row count; it can't see a row edited in place, so **stop anything that writes during teardown**: don't use the app, and note the scheduled backup and Sync (scheduled runs) may still fire.
4. **Stops if any of that failed.** Nothing has been deleted at that point, and the message says how to make a copy by hand instead.
5. **Asks you to type the database name.** Anything else, an empty line, or no input at all, deletes nothing. Right after you type it, the check in step 3 runs again, and any difference deletes nothing. `--yes` skips only the account prompt, and `CI=true` does not answer this for you (see "What Wrangler answers for itself"). If the manifest's `skipped` list names tables the backup could not hold ([Backups and restore](#backups-and-restore)), you must type `<database name> without <those tables>` instead, so you know they are lost.
6. **Deletes the D1 database.** If that fails, the bucket is left alone.
7. **Tries to delete the R2 bucket.** Wrangler can't list or bulk-delete a bucket's objects, and a bucket holding any can't be deleted, so this fails on a bucket that has backups in it, which is the normal case. The script treats that as the expected end and exits 0, with the bucket as its last printed step: empty it in the dashboard (or with a lifecycle rule that expires everything), then `npx wrangler r2 bucket delete <bucket>`, or re-run `npm run teardown`, which finishes the job without asking for a backup folder. **Emptying the bucket destroys every backup in it**, including the weekly ones. The final backup folder holds only the latest data, so download any older backup you want first. Any other bucket error exits 1 and says the database is already deleted.

What you do by hand afterwards:

- **Delete the Worker**, which also deletes the secrets it holds: `npx wrangler delete`.
- **Delete the Access application:** Zero Trust → Access → Applications → the application you added for the Worker.
- **Revoke Akahu access, only if you used Akahu Sync.** README ("Leaving Fernledger") says how.
- **Revoke the D1 usage token, only if you made one** for the [D1 usage bar](#d1-usage-bar-optional). README ("Leaving Fernledger") says how.
- **Decide what to do with the final backup folder.**

## Cloudflare Access (one-time, by hand)

The app has no login of its own. Cloudflare Access sits in front of it, and the Worker checks the Access token on every API request (ADR 0002).

You protect the Worker itself, with an Access application of the **Workers** type. When this was written, the dashboard's Add application screen offered Private destinations, Workers, Public DNS and Service auth. A Workers application is the protection Cloudflare's docs call "Protect one Worker" ([Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)), and it covers every address the Worker answers on, `fernledger.<your-subdomain>.workers.dev` included.

If your Cloudflare account already has an account-wide Access rule (**Protect all Workers**) or a wildcard policy, for example from another project, this Worker still gets **its own** application. Access applies the most specific rule that matches: a hostname or path application first, then a Worker's own application, then the account-wide rule. So the other project's policy won't apply here.

1. **One-time PIN.** In Zero Trust, go to **Integrations → Identity providers** in the left-hand menu and make sure **One-time PIN** is listed. If it isn't, choose **Add new identity provider**, then **One-time PIN** (a new Zero Trust account doesn't get it automatically). It is not under **Settings**, where Cloudflare used to keep it as Authentication → Login methods; that page now offers only Team Domain, Downloads, Admin controls, Plan and Permissions.
2. **Zero Trust → Access controls → Applications → Create new application → Self-hosted and private → Private destinations → Continue with Self-hosted and private.** Deploy the Worker first so it can be chosen.
   - **Worker:** `fernledger`, the `name` in `wrangler.jsonc`.
   - **Traffic:** **All traffic**. **Previews only** would leave the live app open.
   - **Session duration:** 24 hours. This is the length of a sign-in, and the only place it is set: Fernledger has no session of its own. When it runs out anyone sees **Your sign-in has expired** and presses **Sign in again** (README [What it does](../README.md#what-it-does)).
   - **Login methods:** One-time PIN only.

   Cloudflare also describes a quicker route (Workers & Pages → your Worker → **Access**). Its policy options are **Cloudflare account** and **Email domain**, and neither is a list of people, so use the Zero Trust route above.
3. **Policies:** create a **new** policy, and don't attach any reusable policy that already exists in the account.
   - **Name:** Fernledger Members
   - **Action:** Allow
   - **Include → Emails:** each Member's email, the Admin's included.
4. Save the application, then copy its **Application Audience (AUD) tag**: **Zero Trust → Access → Applications**, **Configure** on the application, then **Additional settings**. That is where Cloudflare's [instructions for the AUD tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag) put it for any Access application. They don't describe a Workers application separately, so if yours looks different, look for **Application Audience (AUD) Tag** in its settings.
5. Set the Worker secrets:

   ```bash
   npx wrangler secret put ACCESS_TEAM_DOMAIN   # <your-team>.cloudflareaccess.com
   npx wrangler secret put ACCESS_AUD           # the AUD tag from step 4
   npx wrangler secret put ADMIN_EMAIL          # the Admin's email
   ```

   Your team domain is shown under **Zero Trust → Settings → Team domain**, in the form `<your-team>.cloudflareaccess.com`. It is also the address of Cloudflare's sign-in page (`<your-team>.cloudflareaccess.com`), which you reach by opening the app's address in a private window. Until all three secrets are set, every API request returns 401. The app fails closed.
6. **Check it.** Open `https://fernledger.<your-subdomain>.workers.dev` in a private window. A Member's email should be sent a code and then reach the app. Then try an email that isn't on the list: it should get no code.
7. **Check Sign out.** Press **Sign out** in the header once (the README's [What it does](../README.md#what-it-does) says what it does). The next visit should ask for a code. [Local development](#local-development) can't try it.

**If anyone sees "Not signed in"** (and not "Your sign-in has expired", which signing in again mends): Cloudflare let them through and the Worker refused the API, which is a 401. The Worker log has one line for the kind of refusal, with no token and no email: `auth.refused.no-token` (no Access token reached the Worker, so Access is not in front of the address that was used), `auth.refused.bad-token` (a token that did not verify) or `auth.refused.not-configured` (one of the three secrets in step 5 is missing). A `bad-token` line says which way in a fixed `code`: `ERR_JWT_CLAIM_VALIDATION_FAILED` (the token is for another Access application or team: `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` is not this one's), `ERR_JWS_SIGNATURE_VERIFICATION_FAILED` (it was not signed by this team's keys), `ERR_JWT_EXPIRED` (it is out of date), `ERR_NO_EMAIL` (it has no email), or another `ERR_` code of the jose library's. The team's keys (`<team>.cloudflareaccess.com/cdn-cgi/access/certs`) not being had shows as `ERR_JWKS_TIMEOUT` (too slow), `ERR_JOSE_GENERIC` (Cloudflare answered with something that was not the keys: `ACCESS_TEAM_DOMAIN` is wrong, or Cloudflare is failing) or `ERR_JWKS_NO_MATCHING_KEY` (the token's key is not one of the team's), and only when the network itself fails is there no `code`, but an `errorClass` in its place. An email that is not in the policy never gets this far: Cloudflare gives it no code.

**Adding or removing a Member:** edit the "Fernledger Members" policy. The app needs no changes. Give a new Member the app's address. Its **How to sign in** page prints as a one-page guide for anyone who finds the email code hard, and **About your data** shows what you write in Settings under "About your data", so fill those in too. As the Admin, print **How to sign in** and give it to each Member before their first sign-in: the page says so to you alone, and the printout has a line to write your name and phone on, as well as the contact you set in Settings.

**Home Screen icon (optional):** Members can add Fernledger to an iPad or phone's Home Screen (README [What it does](../README.md#what-it-does)). On Android (Chrome) the icon shows with no extra setup, tried on a Workers application. iOS may fetch its icon, `/apple-touch-icon.png`, without the Access sign-in cookie, so Access answers with its login page and the Home Screen shows a plain tile. That is fine, and nothing else is affected. If your dashboard lets you add an Access application for an icon's path (`apple-touch-icon.png`, and `icon-192.png`, `icon-512.png` and `icon-maskable-512.png` for the manifest's icons), give it one policy, **Action: Bypass** with **Include: Everyone**; if it doesn't, leave the tile plain. Bypass turns off Access checks and logging for that path only, and each icon holds no data. Bypass nothing else.

**Changing the Admin:** run `wrangler secret put ADMIN_EMAIL` again.

`preview_urls` is off in `wrangler.jsonc`, so the Worker has no preview hostnames. A Workers application set to **All traffic** would cover them if you turned them on.

### Smoke check (optional)

After a deploy, `npm run deploy` can check the live site through an Access **service token**, a credential for a script and not a person. It makes three requests. First, the page with the token should come back 200 and name this build's entry script, which shows Access let the token in and the new version is being served. Second, `/api/me` with the token should come back 401 from the Worker: a service token carries no email, so the Worker refuses it (the log line is `auth.refused.bad-token` with `ERR_NO_EMAIL`), and the token never reaches any data. Third, the page without the token should not serve the app, which shows Access is still in front of it. If a request fails, deploy says which one and exits with an error, after the rollback instructions. It never rolls back by itself. Without the settings below, it says the check was skipped.

1. **Zero Trust → Access → Service credentials → Service Tokens → Create Service Token.** Name it `fernledger-smoke` and choose a duration (a year, say). Note when it runs out, because the check fails from then on. Copy the **Client ID** and **Client Secret**. The secret is shown only once.
2. On the Fernledger application, add a **second** policy: **Name:** Fernledger smoke check, **Action:** Service Auth, **Include → Service Token:** `fernledger-smoke`. Leave "Fernledger Members" as it is.
3. Set three environment variables in the shell you deploy from. Keep them out of the repo and out of any file in it:

   ```bash
   export FERNLEDGER_URL=https://fernledger.<your-subdomain>.workers.dev FERNLEDGER_SMOKE_ID=<client id> FERNLEDGER_SMOKE_SECRET=<client secret>
   ```

   In PowerShell, use `$env:FERNLEDGER_URL = "…"` for each one. The check prints status codes only, never the token or a page.

To stop using it, delete the service token. Its policy then matches nothing.

## D1 usage bar (optional)

README ([What it does](../README.md#what-it-does)) says what the bar shows. D1 Free allows 5 million rows read and 100,000 rows written a day for the whole Cloudflare account, and setting up Rules can use the reads quickly. If you skip this, the Rules page says how to turn the bar on and nothing else changes. Turning it on lets the Worker ask **your own** Cloudflare account for its usage, the one extra outbound call ([ADR 0010](adr/0010-outbound-calls.md)). The request carries the token, your account ID and today's date, and none of your data.

1. **Create an account-owned API token** (Cloudflare's [Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)), not a user token under My Profile. An account token isn't tied to one person, so it keeps working if they leave the account, and Cloudflare lists Account Analytics as supported by account tokens. In the Cloudflare dashboard:
   - **Manage account → Account API tokens → Create Token**, then **Custom token** (Get started).
   - **Token name:** `Fernledger D1 usage (read only)`.
   - **Permissions:** Account → Account Analytics → Read. **Nothing else.** The token can then read your account's analytics and change nothing.
   - **Resources:** leave it limited to this one account. Don't add IP address filtering: a Worker's outbound address isn't fixed.
   - **Expiration:** optional. When the token expires the bar says "Usage unavailable" until you make a new one and run the `secret put` below again.
   - **Continue to summary → Create Token**, and copy the token now: Cloudflare shows it once.
2. **Copy your account ID:** in the dashboard, search (CMD/CTRL + K) for `Copy account ID`, or open **Workers & Pages** and copy it from **Account Details** ([Cloudflare's steps](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)).
3. **Set both Worker secrets.** Wrangler asks for each value at a prompt, so neither goes on a command line or into a file:

   ```bash
   npx wrangler secret put CF_ANALYTICS_TOKEN   # the token from step 1
   npx wrangler secret put CF_ACCOUNT_ID        # the account ID from step 2
   ```

   Both are needed. With one, or neither, the bar stays off and Setup needed (Settings, and the Rules page) names what is missing. If your login reaches more than one Cloudflare account, set `CLOUDFLARE_ACCOUNT_ID` first so Wrangler puts the secrets on the right Worker, as in [Create the resources and deploy](#create-the-resources-and-deploy).
4. **Check:** open **Rules** and choose **Apply the Rules to all Transactions**. In the question it asks, **Free database allowance** shows rows read and rows written today, a badge for each (**Plenty left**, **Running low** from 70% used, **Almost used** from 85% used, **Used up** once the limit is reached), and when the allowance starts again in NZ time (00:00 UTC, about midday or 1 pm). The figures are for the whole account, not only Fernledger, and run a few minutes behind, so a number that hasn't moved yet after an Import or a run is normal. The question reads them each time it opens, and again when a run that is paused for the allowance is shown (the button is off while a run is going, so the figures are in the run's progress then), and when you choose **Check again**; the figures are never kept from the time before. The Admin's header has its own bar as well, **Free allowance left today**, of whichever of the rows read and rows written has less left, as "about 62%". It reads the figures as the page loads, every 5 minutes while Fernledger is open in a window you can see (a tab in the background does not ask), and when you come back to a window whose last reading is 5 minutes old, so an open window asks for them about 12 times an hour at the most. Going from page to page asks for nothing, and it is never a cron. It has the same badge words and colours as the question for the same figures (amber **Running low** from 70% used, red **Almost used** from 85% used); hover over it, focus it or tap it for both figures (in a narrow header it is the bar and its value, and on a phone it is in the header's menu with the words and the figures written out). If the figures cannot be had it says **Allowance unknown**, and nothing else. The first time, compare them with Cloudflare's own (D1 in the dashboard, your database, **Metrics**, for today in UTC): the bar asks for today's UTC date, which Cloudflare's documentation shows in its examples but does not state outright for this dataset.

If the page says **Usage unavailable**, it says why. **Cloudflare refused the token or the account ID**, or **found no such account for this token**: `CF_ACCOUNT_ID` must be the account the token belongs to, and the token needs Account Analytics: Read. Otherwise Cloudflare could not be reached or answered with something unexpected, and **Check again** is the answer unless it keeps happening. The Worker log has one line for the kind of failure, with no message and none of your values: `d1-usage.refused` (a 401 or 403), `d1-usage.no-account` (an answer with no account), `d1-usage.failed` (not reached, too slow, a redirect, or any other error status) or `d1-usage.unreadable` (not the two figures, including an answer that carries errors). The bar never stops the app: only the Admin can see it, and the Rules, Imports and everything else carry on without it.

**Turning it off:** `npx wrangler secret delete CF_ANALYTICS_TOKEN`, then revoke the token ([README: Leaving Fernledger](../README.md#leaving-fernledger)).

## Update pull requests

For a copy made with the **Deploy button** (README [Updating](../README.md#updating)). `.github/workflows/upgrade-check.yml` runs weekly, and from the Actions tab whenever you choose **Run workflow**. It compares your `package.json` version with the latest published Fernledger release. If there is a newer one it opens a pull request, from the branch `fernledger-update/vX.Y.Z`, that carries the release notes and the changes.

- **Once, in your copy:** Settings, Actions, General, Workflow permissions, tick **Allow GitHub Actions to create and approve pull requests**. Without it the workflow fails with a message saying so; once it is on, run the workflow again (it replaces its own branch, so a re-run is safe).
- **Merging does not touch your database.** `npm run deploy`, run from the merged commit, is the step that takes the pre-deploy backup, records the restore point and applies migrations ([above](#create-the-resources-and-deploy)). If a Cloudflare build deploys on every merge, it skips those, so run `npm run deploy` as well (or instead). The Deploy button is still Planned, so this describes the intended setup. For a major release, read its upgrade notes first; the pull request says when it is one.
- **You are trusting upstream.** A merged update runs upstream's code in your build and deploy (package scripts, `.githooks`, `scripts/`). The tick-box above lets Actions approve pull requests as well as create them. Pull requests opened with `GITHUB_TOKEN` don't trigger `pull_request` checks, so no CI runs on them: review the diff yourself.
- **Closing a pull request without merging** skips that release. The next release opens a new one.
- The pull request makes your tracked files match the release, so changes you made to them show up in its diff as removals. Files git doesn't track, such as `.dev.vars`, are left alone.
- **Workflow files are never changed by it**: GitHub doesn't let an Actions run edit them. If a release changes one, the pull request lists it for you to compare and copy by hand.
- It reads the public release list and nothing else, using the `GITHUB_TOKEN` GitHub provides to the run. It adds no secrets, and the Worker is not involved.
- GitHub pauses scheduled workflows in a public repository with no activity for 60 days. If the weekly run stops, re-enable it in the Actions tab, or run it by hand.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

On a fresh clone, run `npm run gen` once (or any of `npm run check`, `typecheck` or `build`, which run it for you) before opening the project in an editor. It generates the route tree and the API types the browser code imports.

Access isn't in front of the local dev server, so `DEV_USER_EMAIL` stands in for the signed-in Member. It's honoured only on `localhost`. Set it to something other than `ADMIN_EMAIL` to see the read-only view. The header's **Sign out** link goes to `/cdn-cgi/access/logout`, which belongs to Access, so on the dev server it only reaches the app's own fallback page.

The dev server shows a "Development only" bar to switch between the Admin and a read-only Member. It works by a cookie that the Worker honours only on `localhost`, and only when `DEV_USER_EMAIL` is set. Production builds don't include the bar.

**Sample data:** `npm run seed` applies the local migrations, then loads made-up data into the local database that `npm run dev` uses. It only ever touches the local database. The convention for seed files:

- Each feature that adds tables adds its own `seed/NN-name.sql`. Number it after the tables it needs (ticket 8 uses `08-accounts.sql`). Files run in filename order.
- Each file is safe to run again: `insert or replace`, or delete then insert.
- Data is made up, following the hard rules in `AGENTS.md` (bank code 99, no real names or numbers). The secret scan checks these files too.

**Browser tests:** `npm run test:e2e` builds the app and runs Playwright with axe checks (in light, and the tests that depend on the theme in dark too), against the production build with the real security headers. It fails on any console error or Content-Security-Policy violation. Run `npx playwright install chromium` once first, or set `PLAYWRIGHT_CHANNEL=msedge` (or `chrome`) to use a browser you already have. The tests use their own empty local database (`.wrangler/e2e-state-<port>`, rebuilt on every run), never the one `npm run dev` uses. Each checkout has its own port (20000–29999, from its folder), so checkouts can run them side by side; `E2E_PORT` overrides it. `npm run test:e2e:shards` builds once and runs the suite in four parts side by side, each with a port and database of its own (ports 29901–29904; `E2E_SHARDS` and `E2E_SHARD_PORT` change them), as CI does on four runners.
