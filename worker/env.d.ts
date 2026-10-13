// Secrets (wrangler secret put / .dev.vars) aren't in wrangler.jsonc, so `wrangler types` can't see them.
declare namespace Cloudflare {
  interface Env {
    ACCESS_TEAM_DOMAIN?: string // e.g. <team>.cloudflareaccess.com
    ACCESS_AUD?: string // Access application audience tag
    ADMIN_EMAIL?: string
    DEV_USER_EMAIL?: string // local dev only
    AKAHU_APP_TOKEN?: string // optional: Akahu Sync is off without both Akahu tokens (worker/features.ts)
    AKAHU_USER_TOKEN?: string
    CF_ANALYTICS_TOKEN?: string // optional: the D1 usage bar is off without both of these (worker/features.ts). A Cloudflare account API token with Account Analytics Read only.
    CF_ACCOUNT_ID?: string // the Cloudflare account that token reads the D1 usage of
  }
}
interface Env extends Cloudflare.Env {}
