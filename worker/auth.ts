import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { parse as parseCookie } from 'hono/utils/cookie'
import * as z from 'zod/mini'

export type Role = 'admin' | 'member'
export type Member = { email: string; role: Role }

export type AuthConfig = {
  getKey: JWTVerifyGetKey
  issuer: string
  audience: string
  adminEmail: string
}

/** The Admin is whoever's email matches the Admin setting, case-insensitively; everyone else is a read-only Member. */
export const roleFor = (email: string, adminEmail: string | undefined): Role =>
  adminEmail && email.toLowerCase() === adminEmail.toLowerCase() ? 'admin' : 'member'

const emailClaim = z.string().check(z.trim(), z.minLength(1))

/**
 * Why a request was refused, for the log (`logEvent`): the event says which of three things it was (a Worker secret is missing, no Access token, or one that did not verify). For a
 * token that did not verify, `code` is jose's own fixed code (`ERR_JWT_EXPIRED`; `ERR_JWT_CLAIM_VALIDATION_FAILED` for another application or issuer;
 * `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`...) or ours (`ERR_NO_EMAIL`), and `error` is the class of anything else that went wrong, such as the key set not being fetched. Never jose's
 * message, which can echo the token. The page sees only a 401.
 */
export type Refusal = { event: string; code?: string; error?: unknown }

/** Verifies the Cloudflare Access JWT: the Member it is for, or why not (anything that isn't a valid, signed, in-date token for this app). */
export async function authenticate(request: Request, config: AuthConfig): Promise<{ member: Member } | { refused: Refusal }> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return { refused: { event: 'auth.refused.no-token' } }
  try {
    const { payload } = await jwtVerify(token, config.getKey, {
      issuer: config.issuer,
      audience: config.audience,
    })
    const parsed = z.safeParse(emailClaim, payload.email)
    if (!parsed.success) return { refused: { event: 'auth.refused.bad-token', code: 'ERR_NO_EMAIL' } }
    const email = parsed.data.toLowerCase()
    return { member: { email, role: roleFor(email, config.adminEmail) } }
  } catch (error) {
    return { refused: error instanceof errors.JOSEError ? { event: 'auth.refused.bad-token', code: error.code } : { event: 'auth.refused.bad-token', error } }
  }
}

const jwksCache = new Map<string, JWTVerifyGetKey>()

/** Builds config from Worker secrets; null if any are missing, so the app fails closed. */
export function authConfigFromEnv(env: Env): AuthConfig | null {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience, ADMIN_EMAIL: adminEmail } = env
  if (!team || !audience || !adminEmail) return null
  const issuer = `https://${team}`
  let getKey = jwksCache.get(issuer)
  if (!getKey) {
    getKey = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
    jwksCache.set(issuer, getKey)
  }
  return { getKey, issuer, audience, adminEmail }
}

const DEV_MEMBER: Member = { email: 'dev.member@example.com', role: 'member' }

/**
 * Local dev only: Access isn't in front of `vite dev`, so DEV_USER_EMAIL (set in .dev.vars) stands in, and only on localhost.
 * The `fernledger_dev_as` cookie (`admin` or `member`) lets a developer switch identity; any other value uses DEV_USER_EMAIL.
 */
export function devMember(request: Request, env: Env): Member | null {
  const host = new URL(request.url).hostname
  if (!env.DEV_USER_EMAIL || (host !== 'localhost' && host !== '127.0.0.1')) return null
  const devAs = parseCookie(request.headers.get('Cookie') ?? '').fernledger_dev_as
  if (devAs === 'member') return DEV_MEMBER
  if (devAs === 'admin' && env.ADMIN_EMAIL) return { email: env.ADMIN_EMAIL.toLowerCase(), role: 'admin' }
  const email = env.DEV_USER_EMAIL.toLowerCase()
  return { email, role: roleFor(email, env.ADMIN_EMAIL) }
}
