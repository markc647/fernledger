# Runs on the Cloudflare Workers Free plan

The app must run within the Workers Free plan, so anyone can self-host it at no cost. That rules out anything that needs Workers Paid, such as Containers or long CPU-bound requests.

## Consequences

- Each request and cron run gets 10 ms of CPU. Waiting on D1 or `fetch` doesn't count, but parsing and looping in the Worker does. Heavy work is split up: a large CSV Import is parsed in the browser and sent in chunks of about 500 rows, and Rules re-run as SQL, not in JS loops.
- A single invocation is limited to 50 subrequests and 50 D1 queries. Writes are batched, and Sync pages are written with one batch per page.
- D1 Free allows 100k rows written per day. A full Import or a Rule re-run over all history must stay well under that.
- D1 Free allows 5 million rows read per day, and bills the rows a query reads, not the rows it returns. A query with no usable index reads the whole table, and a `COUNT` reads every row it counts. So a list pages off an index and stops after one page, and a total is counted once per search, not per page; a caller that shows no total (the Summary) doesn't count. A text search, or a sort by any column but date, reads every Transaction the other filters keep, and a sort reads each about three times (the scan, an Account lookup and the sort), five for a paired Transfer (its other half and that one's Account). At 100,000 Transactions that is about 300,000 rows a page, or 15 pages a day; at 10,000, about 150. Tests pin the rows read (`worker/transaction-search.test.ts`), so a change that makes a request read more fails.
- There are at most 5 cron triggers per account. We use 3: daily Sync, Sync retry, and weekly backup.
