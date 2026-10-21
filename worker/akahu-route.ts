import { Hono } from 'hono'
import { akahuTokens, listAkahuAccounts } from './akahu'
import type { AppEnv } from './app-env'
import { AKAHU_SYNC, requireFeature } from './features'

// The Akahu accounts the Admin picks from when linking an Account (spec 29). Asking stores nothing: only the Account the Admin
// then links is ever synced, so Akahu seeing more accounts than you want in the app cannot put them there (spec 31).
//
// A read, so the write guard in app.ts does not ask for the Admin: this does, and first, so a Member gets the same answer whether
// or not Sync is set up. Then the feature check, so a Deployer who has not added the Akahu tokens gets "Not set up" and no call
// goes out (worker/d1-usage-route.ts does the same, for the same reasons).
export const akahu = new Hono<AppEnv>()
  .use(async (c, next) => {
    if (c.var.member.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
    await next()
  })
  .use(requireFeature(AKAHU_SYNC))
  .get('/accounts', async (c) => {
    // The tokens are there: requireFeature has already refused without them.
    const result = await listAkahuAccounts(akahuTokens(c.env)!)
    // The reason is one of three fixed words, never Akahu's own, which can echo a token.
    // Only what the picker shows: the rest of what Akahu says is for Sync to keep, and the logo URL is not for the browser at all.
    return result.ok ? c.json(result.value.map(({ _id, name, formatted_account }) => ({ _id, name, formatted_account }))) : c.json({ error: 'Akahu unavailable', reason: result.reason }, 502)
  })
