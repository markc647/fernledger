import { app } from './app'
import { logEvent } from './log'

export default {
  fetch: app.fetch,

  async scheduled() {
    // Phase 3 (Sync) and Phase 7 (backup) hook in here, keyed on the controller's cron.
    logEvent('cron.run')
  },
} satisfies ExportedHandler<Env>
