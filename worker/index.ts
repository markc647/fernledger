import { app } from './app'
import { BACKUP_CRON, continueBackup, startBackup } from './backup'
import { logEvent } from './log'
import { BACKUP_CHUNKS, continueRerun, CRON_CHUNKS } from './rule-rerun'

export default {
  fetch: app.fetch,

  async scheduled(controller, env) {
    // Phase 3 (Sync) hooks in here, keyed on the controller's cron.
    logEvent('cron.run')
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
