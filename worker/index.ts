import { Hono } from 'hono'
import { authConfigFromEnv, authenticate, devMember, isJson, isWrite, type Member } from './auth'
import { logEvent } from './log'
import { SECURITY_HEADERS } from './security-headers'

type AppEnv = { Bindings: Env; Variables: { member: Member } }

const app = new Hono<AppEnv>()

// Runs outermost, so even refusals and errors carry the headers.
app.use('*', async (c, next) => {
  await next()
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value)
})

// Every /api request is authenticated before routing, so unknown routes reveal nothing. Fail closed.
app.use('/api/*', async (c, next) => {
  const config = authConfigFromEnv(c.env)
  const member = devMember(c.req.raw, c.env) ?? (config && (await authenticate(c.req.raw, config)))
  if (!member) return c.json({ error: 'Unauthorised' }, 401)
  c.set('member', member)
  await next()
})

app.use('/api/*', async (c, next) => {
  if (!isWrite(c.req.method)) return next()
  if (c.var.member.role !== 'admin') return c.json({ error: 'Read-only' }, 403)
  // Blocks cross-site forgery: a browser sends Origin on cross-site writes, and a page on another site
  // can't send a JSON content type without a CORS preflight, which this app never grants.
  if (c.req.header('Origin') !== new URL(c.req.url).origin) return c.json({ error: 'Wrong origin' }, 403)
  if (!isJson(c.req.header('Content-Type'))) return c.json({ error: 'JSON body required' }, 415)
  await next()
})

app.get('/api/me', (c) => c.json(c.var.member))

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((error, c) => {
  logEvent('request.failed', { error })
  return c.json({ error: 'Something went wrong' }, 500)
})

export default {
  fetch: app.fetch,

  async scheduled() {
    // Phase 3 (Sync) and Phase 7 (backup) hook in here, keyed on the controller's cron.
    logEvent('cron.run')
  },
} satisfies ExportedHandler<Env>
