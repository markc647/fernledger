# Releasing

For the maintainer. What a version number promises, and what each release does for a Deployer, is in README [Updating](../README.md#updating); this page is how a release is made and what protects it.

## What the version number means here

[Semver](https://semver.org), with `package.json`'s `version` the one source of truth and the Git tag `vMAJOR.MINOR.PATCH` always equal to it.

- **Patch:** fixes only. It may carry an add-only migration if the fix needs one.
- **Minor:** new features. No manual steps.
- **Major:** anything that needs a manual step, such as a new required secret, or a database change that the previous release cannot run against. The release notes say what to do.

Migrations are add-only in every release ([ADR 0009](adr/0009-expand-contract-migrations.md)), so the previous release still runs against the new schema and a Deployer can roll back by redeploying it. A `DROP` or `RENAME` ships in a later release than the one that stopped using the thing, and never in a patch. `npm run migrations:check` rejects both today, because no release has needed one; the change that first does will teach it the exception, with a test.

## Release notes

They are the GitHub Release's text, written once. The update pull request that Deploy-button copies receive carries them ([setup.md](setup.md#update-pull-requests)), so write them for a Deployer, not a contributor. Start from GitHub's "Generate release notes", then make sure these headings are there:

- **What's new:** one line per change a Deployer would notice.
- **Fixes**
- **Upgrade notes:** always present. "None" for a minor or patch release; for a major release, every manual step in order.
- **Security:** a link to the GitHub Security Advisory, when there is one. Security fixes ship as a patch release straight away.

## Making a release

1. On `main`, `npm run check` is green and the browser tests (`npm run test:e2e`) pass in CI.
2. Set the version: `npm version X.Y.Z --no-git-tag-version`, and commit it ("Release X.Y.Z").
3. For the first release of a new minor or major (X.Y.0), capture its sample database on that commit: `npm run sample-db -- capture vX.Y`, and commit the two files it writes ([below](#sample-databases)). `npm run check` fails until a sample for the version in `package.json` exists, so this can't be forgotten.
4. Merge, then tag the merge commit and push the tag: `git tag -a vX.Y.Z -m "Fernledger X.Y.Z"`, `git push origin vX.Y.Z`.
5. Create the GitHub Release from that tag, with the notes above. Publish it: drafts and pre-releases are ignored by the update check, which is how you can try a release candidate (`vX.Y.Z-rc.1` as a pre-release) without sending it to anyone.

Copies hear about a published release within a week. There is nothing else to do. The Worker itself never checks for updates ([README](../README.md#updating)).

## Sample databases

`test/sample-dbs/` holds a small, made-up database (bank 99 and example.com data only) for each minor release, as it was when that release was made: `vX.Y.sql`, a dump that includes Wrangler's `d1_migrations` table, and `vX.Y.json`, a snapshot of every table's columns and rows with a hash of every migration. `scripts/sample-dbs.test.mjs`, part of `npm run check`, loads each sample into a fresh SQLite database, applies the migrations the sample doesn't yet have the way `wrangler d1 migrations apply` does, and fails if:

- a migration fails to apply;
- a table, a column, or any row of the snapshot has gone or changed;
- SQLite's integrity check or foreign-key check fails;
- a migration that a release already applied has been edited or removed (add a new migration instead).

So every earlier minor release is proven to upgrade to the latest, and a skipped version is as safe as an upgrade one step at a time. It uses SQLite (`node:sqlite`) as a stand-in for D1, and never touches Cloudflare. A migration that rewrites existing values will fail it, and will need its expected change written into the test.

**Adding one** is step 3 above. `npm run sample-db -- capture vX.Y` builds a database from the migrations on the current commit, loads the made-up data in `seed/*.sql` (and any file given as `--data extra.sql`, for tables the seed doesn't fill), and writes the two files. Read them before committing: the data must be made up. It refuses to overwrite a sample, because a sample is history. Run it on the release commit, not later.

## What else guards the promise

- **The Worker contacts no one but Akahu** (and, to check a sign-in, your own Cloudflare Access): `worker/outbound.test.ts` sends requests to every route and runs every cron with `fetch` replaced by a recorder, and `scripts/outbound-calls.test.mjs` fails on any `fetch`, socket, WebSocket or beacon in `worker/` or `src/`. Akahu Sync will add its one module to the allowed list in the second, and be exercised by the first.
- **The update check is off in this repository.** `.github/workflows/upgrade-check.yml` is for copies; it does nothing here. `scripts/upgrade-check.test.mjs` checks that, its permissions, and that its actions are pinned by commit.
