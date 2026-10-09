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

   In order, `npm run deploy` confirms the account, confirms the workers.dev subdomain (below), checks the database and bucket exist (it stops and points you at `npm run setup` rather than let Wrangler create them with no location), builds, takes a complete backup ([below](#the-backup-before-a-deploy)), records a D1 bookmark (restore point), applies remote migrations from `migrations/`, and deploys. **If the backup fails it stops there, with nothing changed.** It ends by printing the bookmark with rollback instructions, and prints them too if a migration or the deploy fails. The printed commands start with `CLOUDFLARE_ACCOUNT_ID=<id>` so they run as printed. In PowerShell, set `$env:CLOUDFLARE_ACCOUNT_ID` first and drop the prefix. [Rolling back](#rolling-back) covers what to do with them.

Every script takes `--yes` to skip the account prompt (needed when there's no terminal). `npm run deploy` also takes `--workers-dev-registered` (below), `--skip-build` if `dist/` is already built, and `--skip-backup` (only after you've made a copy by hand). If a script fails, it names the Wrangler command and its exit code and nothing more, because Wrangler's own output can contain your account email. Run the printed command by hand to see it.

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
| "About to apply N migration(s)… continue?" (`d1 migrations apply`) | Yes | Your account confirmation, the backup and the restore point before it are the safeguard. The migrations applied are printed |
| "Delete this database?" (`d1 delete`) | Yes | `npm run teardown` passes `--skip-confirmation` itself, and only after you type the database name ([Leaving Fernledger](#leaving-fernledger-teardown)) |

### Test-only environment variables

`FERNLEDGER_WRANGLER` (a stand-in for the Wrangler binary) and `FERNLEDGER_MIGRATIONS_DIR` (a stand-in for `migrations/`) exist so the script tests can run without touching Cloudflare. Don't set them for a real run.

## Backups and restore

The Worker backs up every table to your R2 bucket (`BACKUPS` in `wrangler.jsonc`) on the weekly cron (Sunday 15:00 UTC), under `backups/<NZ date>/`. README ("Recoverable") says what that protects. Nothing deletes a backup; to remove old ones, delete them in the R2 dashboard.

- `manifest.json` lists each table with its row count and CREATE statement, and each part's object key, size and SHA-256 checksum. **A backup exists only once its manifest does**; the restore script and you should ignore a folder without one.
- Each table is split into `<table>.<n>.ndjson` parts of up to 1000 rows and 256 KB, one JSON object per row.
- Tables come from the database's own schema, so a table added by a later release is backed up with no change to the backup code. The exceptions are tables that can't be read page by page by rowid: `WITHOUT ROWID` tables, virtual (for example full-text search) tables and their internal shadow tables. These are **not copied**; the manifest's `skipped` list names each with the reason, and the restore script prints it. Fernledger's own tables are ordinary tables. A future table of one of those kinds will need backup support added with it.
- A backup refuses (and logs `backup.failed` with `BackupFormatError`) a number JSON can't hold exactly: a whole number above 2^53 or infinity. Money is whole cents, far below that.
- A run on a date that already has a manifest is skipped, never overwritten.

**How a run fits the Free plan (ADR 0004).** One invocation gets 10 ms of CPU and 50 subrequests, so it can write only about 1 MB of backup (and at most 40 D1 and R2 operations on the weekly cron, 20 on a continuation). A run saves its place after every part and carries on in the Worker's other cron invocations (the two daily ones) until it finishes. That gives roughly 15 MB of backup a week, about **40,000 to 50,000 Transactions** at around 300 bytes each, with the rest of the database counted in. A database that size or smaller finishes within the week, usually within a few days.

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

1. **Code only (the usual fix).** Migrations only add (ADR 0009), so the previous release still runs on the newer schema. Redeploy it: check out the previous release's tag (`git checkout <tag>`, then `npm install`) and run `npm run deploy`, or run `npx wrangler rollback` to put back the previous deployed version. Either leaves your data as it is. `npm run deploy` prints the commands, with your account ID in them.
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

Restore into an **empty** database that has the schema. A restore adds rows and never overwrites, and it refuses a database that already has rows in any backed-up table or lacks a backed-up column (a database with extra columns, from a newer schema, is fine). The one exception is the starter Categories that the migrations add: if nothing else has rows, the restore replaces them with the backup's Categories (it deletes the starter rows first, which is safe only because every other table is empty, so nothing can refer to them).

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
- **Delete the Access application:** Zero Trust → Access → Applications → Fernledger.
- **Revoke Akahu access, only if you used Akahu Sync.** README ("Leaving Fernledger") says how.
- **Decide what to do with the final backup folder.**

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

**Adding or removing a Member:** edit the "Fernledger Members" policy. The app needs no changes. Give a new Member the app's address. Its **How to sign in** page prints as a one-page guide for anyone who finds the email code hard, and **About your data** shows what you write in Settings under "About your data", so fill those in too.

**Changing the Admin:** run `wrangler secret put ADMIN_EMAIL` again.

`preview_urls` is off in `wrangler.jsonc`, because version preview hostnames wouldn't match this application and would fall back to whatever wildcard policy the account has.

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

Access isn't in front of the local dev server, so `DEV_USER_EMAIL` stands in for the signed-in Member. It's honoured only on `localhost`. Set it to something other than `ADMIN_EMAIL` to see the read-only view.

The dev server shows a "Development only" bar to switch between the Admin and a read-only Member. It works by a cookie that the Worker honours only on `localhost`, and only when `DEV_USER_EMAIL` is set. Production builds don't include the bar.

**Sample data:** `npm run seed` applies the local migrations, then loads made-up data into the local database that `npm run dev` uses. It only ever touches the local database. The convention for seed files:

- Each feature that adds tables adds its own `seed/NN-name.sql`. Number it after the tables it needs (ticket 8 uses `08-accounts.sql`). Files run in filename order.
- Each file is safe to run again: `insert or replace`, or delete then insert.
- Data is made up, following the hard rules in `AGENTS.md` (bank code 99, no real names or numbers). The secret scan checks these files too.

**Browser tests:** `npm run test:e2e` builds the app and runs Playwright with axe checks in light and dark, against the production build with the real security headers. It fails on any console error or Content-Security-Policy violation. Run `npx playwright install chromium` once first, or set `PLAYWRIGHT_CHANNEL=msedge` (or `chrome`) to use a browser you already have. The tests use their own empty local database (`.wrangler/e2e-state`, rebuilt on every run), never the one `npm run dev` uses. Set `E2E_PORT` if another checkout is already using port 5199.
