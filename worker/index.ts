import { app } from './app'
import { BACKUP_CRON, continueBackup, startBackup } from './backup'
import { logEvent } from './log'
import { BACKUP_CHUNKS, continueRerun, CRON_CHUNKS } from './rule-rerun'
import { SYNC_CRON, syncAll } from './sync'

export default {
  fetch: app.fetch,

  async scheduled(controller, env) {
    logEvent('cron.run')
    // Akahu Sync, on the daily morning cron. It does nothing at all unless both Akahu tokens are set and an Account is linked
    // (ADR 0008), so a deployment that imports CSVs costs one query here. The retry cron of ticket 29 (#30) will be the second
    // daily one; until then a failed Sync waits for tomorrow.
    if (controller.cron === SYNC_CRON) await syncAll(env, new Date(controller.scheduledTime))
    // The weekly cron starts a backup; every other cron carries on an unfinished one, and a Rules re-run that is running (the
    // weekly cron spends 40 of its 50 queries on the backup). Each costs one query when there is nothing to do. A re-run does
    // fewer chunks in a run that is carrying a backup on too, which already has the invocation's encoding and hashing to do.
    if (controller.cron === BACKUP_CRON) {
      await startBackup(env, controller.scheduledTime)
    } else {
      const carriedOn = await continueBackup(env)
      await continueRerun(env.DB, carriedOn ? BACKUP_CHUNKS : CRON_CHUNKS)
    }
  },
} satisfies ExportedHandler<Env>
