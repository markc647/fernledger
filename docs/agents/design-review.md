# Design review screenshots

For an agent asked to show the user what a UI change looks like before it is merged or deployed: screenshots of the pages it touches, with made-up data, on a review canvas the user comments on.

## Take the screenshots

```bash
node scripts/review-shots.mjs
```

One foreground command, about two minutes. It gives a fresh local database (in `.wrangler/review-state-<port>`, or under `TEST_TEMP_ROOT`), builds the app, serves it on a port of this checkout's own (30000–39999, from its folder; `REVIEW_PORT` overrides it), puts in the made-up household through the API, takes the screenshots, and stops the server it started. `npm run dev`'s data and the browser tests' database are never touched.

- `--only <names>` takes the screenshots whose names contain any of the given parts, `|` between them, such as `--only "rules|budgets"`.
- `--skip-build` reuses `dist/` when nothing has changed since the last build.
- `--out <folder>` puts them elsewhere. The default is `test-results/review-shots/`, which git ignores.
- `PLAYWRIGHT_CHANNEL=msedge` (or `chrome`) uses a browser already on the machine, as the browser tests do.
- A few screenshots need a feature the Deployer's secrets switch on, and are left out of a run without them. Akahu Sync is one: `AKAHU_APP_TOKEN=app_example AKAHU_USER_TOKEN=user_example node scripts/review-shots.mjs --only settings-sync-run` photographs a Sync the Admin ran, which Akahu then refuses (made-up tokens, so it is a failed run, which is the state worth reviewing). Use made-up tokens, never real ones. Secrets reach the Worker through the build, so a run like this cannot use `--skip-build`; a later run without them has to rebuild too.

It exits 1 and names each screenshot that failed. The others are still taken.

## The data

Four Accounts numbered 99-9999-9999999-NN (bank 99 is no real bank, and the secret scan allows that number): an everyday account, savings, a Visa card and a car loan, with Transactions from May to mid-October 2026. They have Rules, Overrides, Notes, Transfers, Budgets and a few Uncategorised rows. The same seed gives the same data on every run, so screenshots from before and after a change compare. Every name in it is made up. Keep it that way: this repo is public.

## Add a screenshot

Add an entry to `SHOTS` in `scripts/review-shots.mjs`: a `name`, the `path`, and as needed `role: 'member'`, `theme: 'dark'`, `viewport: PHONE`, `fullPage: false`, and `before` for what to click first (open a menu, fill a form). Wait for something you can see, never a fixed time.

## Put them in front of the user

- One artboard per screenshot on the review canvas, named for its screen, so a pin says which screen it is about.
- Say on the canvas that the data is made up, and which commit the screenshots are of.
- Read the user's comments back from the canvas, and resolve each thread once its change is built.
