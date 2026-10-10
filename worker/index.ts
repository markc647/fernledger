import { app } from './app'
import { BACKUP_CRON, continueBackup, startBackup } from './backup'
import { logEvent } from './log'
import { continueRerun } from './rule-rerun'

export default {
  fetch: app.fetch,

  async scheduled(controller, env) {
    // Phase 3 (Sync) hooks in here, keyed on the controller's cron.
    logEvent('cron.run')
    // The weekly cron starts a backup; every other cron carries on an unfinished one, and a Rules re-run that is running (the
    // weekly cron spends 40 of its 50 queries on the backup). Each costs one query when there is nothing to do.
    if (controller.cron === BACKUP_CRON) {
      await startBackup(env, controller.scheduledTime)
    } else {
      await continueBackup(env)
      await continueRerun(env.DB)
    }
  },
} satisfies ExportedHandler<Env>
