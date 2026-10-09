import { Hono } from 'hono'
import { authConfigFromEnv, authenticate, devMember, isWrite, type Member } from './auth'

type AppEnv = { Bindings: Env; Variables: { member: Member } }

// Routes are chained (not `app.get(...)` on separate lines) so `AppType` carries them to the typed browser client.
const app = new Hono<AppEnv>()
  // Every /api request is authenticated before routing, so unknown routes reveal nothing. Fail closed.
  .use('/api/*', async (c, next) => {
    const config = authConfigFromEnv(c.env)
    const member = devMember(c.req.raw, c.env) ?? (config && (await authenticate(c.req.raw, config)))
    if (!member) return c.json({ error: 'Unauthorised' }, 401)
    c.set('member', member)
    await next()
  })
  .use('/api/*', async (c, next) => {
    if (isWrite(c.req.method) && c.var.member.role !== 'admin') return c.json({ error: 'Read-only' }, 403)
    await next()
  })
  .get('/api/me', (c) => c.json(c.var.member))

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export type AppType = typeof app

export default {
  fetch: app.fetch,

  async scheduled(controller) {
    // Phase 3 (Sync) and Phase 7 (backup) hook in here, keyed on controller.cron.
    console.log('cron', controller.cron)
  },
} satisfies ExportedHandler<Env>
