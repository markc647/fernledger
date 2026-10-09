import { app } from './app'
import { BACKUP_CRON, continueBackup, startBackup } from './backup'
import { logEvent } from './log'

export default {
  fetch: app.fetch,

  async scheduled(controller, env) {
    // Phase 3 (Sync) hooks in here, keyed on the controller's cron.
    logEvent('cron.run')
    // The weekly cron starts a backup; every other cron carries on an unfinished one.
    if (controller.cron === BACKUP_CRON) await startBackup(env, controller.scheduledTime)
    else await continueBackup(env)
  },
} satisfies ExportedHandler<Env>
