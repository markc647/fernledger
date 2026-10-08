# Runs on the Cloudflare Workers Free plan

The app must run within the Workers Free plan, so anyone can self-host it at no cost. That rules out anything that needs Workers Paid, such as Containers or long CPU-bound requests.

## Consequences

- Each request and cron run gets 10 ms of CPU. Waiting on D1 or `fetch` doesn't count, but parsing and looping in the Worker does. Heavy work is split up: a large CSV Import is parsed in the browser and sent in chunks of about 500 rows, and Rules re-run as SQL, not in JS loops.
- A single invocation is limited to 50 subrequests and 50 D1 queries. Writes are batched, and Sync pages are written with one batch per page.
- D1 Free allows 100k rows written per day. A full Import or a Rule re-run over all history must stay well under that.
- There are at most 5 cron triggers per account. We use 3: daily Sync, Sync retry, and weekly backup.
