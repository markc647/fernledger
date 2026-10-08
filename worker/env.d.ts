// Secrets (wrangler secret put / .dev.vars) aren't in wrangler.jsonc, so `wrangler types` can't see them.
interface Env {
  ACCESS_TEAM_DOMAIN?: string // e.g. <team>.cloudflareaccess.com
  ACCESS_AUD?: string // Access application audience tag
  ADMIN_EMAIL?: string
  DEV_USER_EMAIL?: string // local dev only
}
