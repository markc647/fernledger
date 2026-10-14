import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { readD1Usage } from './d1-usage'
import { D1_USAGE, requireFeature } from './features'

// The Admin's D1 usage bar (worker/d1-usage.ts). A read, so the write guard in app.ts doesn't ask for the Admin: this does, and first,
// so the route answers a Member the same way whether or not it is set up. (/api/features does tell a Member whether it is on.) Only then
// does the feature check run, so a Deployer who hasn't added the secrets gets "Not set up" (the page shows Setup needed) and no call goes out.
export const d1Usage = new Hono<AppEnv>()
  .use(async (c, next) => {
    if (c.var.member.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
    await next()
  })
  .use(requireFeature(D1_USAGE))
  .get('/', async (c) => {
    const result = await readD1Usage(c.env)
    // The reason is one of four fixed words, never Cloudflare's own.
    return result.ok ? c.json(result.usage) : c.json({ error: 'Usage unavailable', reason: result.reason }, 502)
  })
