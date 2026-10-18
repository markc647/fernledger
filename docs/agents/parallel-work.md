# Working beside other agents

For an agent in a worktree, a subagent, or any checkout whose tests run while others' do. The coordinator's brief adds only the task, the branch, and your port.

## Start from the integration branch

A worktree the harness makes starts at `main`, hundreds of commits behind. Before anything else:

```
git fetch origin
git switch -c <branch> origin/integration/v1
```

Until v1 is merged to `main`, every branch starts there and merges back there.

## Shell commands

The worktree guard refuses a command it cannot prove stays inside the worktree, and each refusal costs a turn. Commands it accepts:

- One plain command per call, with literal paths.
- File changes through Edit and Write. A script you need goes in a file, then `node <file>`.
- `git` subcommands as separate calls.
- In Git Bash, `MSYS_NO_PATHCONV=1` keeps a `-g` pattern with a slash from being turned into a Windows path.

Heredocs, `$VAR` paths, loops, `$(…)` and `;` chains with redirects are what it refuses.

You have no task list: `update_plan` belongs to the coordinator.

## Tests run in the foreground

Run every test and check in the foreground and read its result in the same call. A background run, a Monitor, a `sleep` or `until` loop, or a `tail -F` wakes you again after you hand back, so your report is sent twice and the coordinator cannot tell you are done. When you hand back, nothing you started is still running.

A run too long for one call (10 minutes) is split by spec file.

## Sharing the machine

- Use the `E2E_PORT` your brief names, so your server and database are your own. `TEST_TEMP_ROOT=<folder>` works inline on any command.
- `VITEST_MAX_WORKERS=2 npm run check` leaves CPU for the others.
- At most two agents run browser specs at once; the coordinator staggers them.
- Stop a process you started by its PID. Other agents' servers are node processes too, so killing by image name (`taskkill /IM`, `Stop-Process -Name`, `pkill`) stops their runs; `.claude/settings.json` refuses it.

## Which specs to run

- The specs of the pages your change affects (AGENTS.md). `e2e/display.spec.ts` holds most of the suite: run your area of it with `-g "<area>"`.
- After merging `origin/integration/v1` into your branch, also the specs that share helpers or pages with what came in (date-picker `FORM_PAGES`, `report-*.spec.ts`, the contrast sweep). Most extra CI rounds have been one branch breaking another's spec.
- CI runs the full suite when you push.

## Reviewing

A reviewer reads the branch's CI result (`gh run list --branch <branch>`, `gh run view <id>`) instead of running `npm run check` again, and runs a spec only to test a finding. To see a merge with integration, use `git merge-tree --write-tree origin/integration/v1 <branch>`, not a copy of the checkout.
