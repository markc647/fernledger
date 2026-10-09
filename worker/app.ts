import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { validator } from 'hono/validator'
import * as z from 'zod/mini'
import { accounts } from './accounts'
import type { AppEnv } from './app-env'
import { authConfigFromEnv, authenticate, devMember } from './auth'
import { categories } from './categories'
import { changeLogList } from './changelog-list'
import { FEATURES, featureStatuses } from './features'
import { imports } from './imports'
import { logEvent } from './log'
import { isJson, isWrite } from './request-format'
import { SECURITY_HEADERS } from './security-headers'
import { readSettings, rejectedFields, settingsPatch, updateSettings } from './settings'
import { transactions } from './transactions'

// Routes are chained (not `app.get(...)` on separate lines) so `AppType` carries them to the typed browser client.
export const app = new Hono<AppEnv>()
  // Runs outermost, so even refusals and errors carry the headers.
  .use('*', async (c, next) => {
    await next()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value)
  })
  // Every /api request is authenticated before routing, so unknown routes reveal nothing. Fail closed.
  .use('/api/*', async (c, next) => {
    const config = authConfigFromEnv(c.env)
    const member = devMember(c.req.raw, c.env) ?? (config && (await authenticate(c.req.raw, config)))
    if (!member) return c.json({ error: 'Unauthorised' }, 401)
    c.set('member', member)
    await next()
  })
  .use('/api/*', async (c, next) => {
    if (!isWrite(c.req.method)) return next()
    if (c.var.member.role !== 'admin') return c.json({ error: 'Read-only' }, 403)
    // Blocks cross-site forgery: a browser sends Origin on cross-site writes, and a page on another site
    // can't send a JSON content type without a CORS preflight, which this app never grants.
    if (c.req.header('Origin') !== new URL(c.req.url).origin) return c.json({ error: 'Wrong origin' }, 403)
    if (!isJson(c.req.header('Content-Type'))) return c.json({ error: 'JSON body required' }, 415)
    await next()
  })
  .get('/api/me', (c) => c.json(c.var.member))
  .get('/api/settings', async (c) => c.json(await readSettings(c.env.DB)))
  .get('/api/features', (c) => c.json({ features: featureStatuses(FEATURES, c.env, c.var.member.role) }))
  // The guard has already required the Admin, so this only validates the body's shape.
  .patch(
    '/api/settings',
    validator('json', (body, c) => {
      const parsed = z.safeParse(settingsPatch, body)
      if (parsed.success) return parsed.data
      return c.json({ error: 'Invalid settings', fields: rejectedFields(parsed.error.issues) }, 400)
    }),
    async (c) => c.json(await updateSettings(c.env.DB, c.var.member, c.req.valid('json'))),
  )
  .route('/api/accounts', accounts)
  .route('/api/categories', categories)
  .route('/api/change-log', changeLogList)
  .route('/api/imports', imports)
  .route('/api/transactions', transactions)

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((error, c) => {
  // Hono's own refusals, such as a body that isn't JSON, keep their status.
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
  logEvent('request.failed', { error })
  return c.json({ error: 'Something went wrong' }, 500)
})

export type AppType = typeof app
