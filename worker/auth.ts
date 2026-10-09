import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
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

/** Verifies the Cloudflare Access JWT. Returns null for anything that isn't a valid, signed, in-date token for this app. */
export async function authenticate(request: Request, config: AuthConfig): Promise<Member | null> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, config.getKey, {
      issuer: config.issuer,
      audience: config.audience,
    })
    const parsed = z.safeParse(emailClaim, payload.email)
    if (!parsed.success) return null
    const email = parsed.data.toLowerCase()
    return { email, role: roleFor(email, config.adminEmail) }
  } catch {
    return null
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

/** Local dev only: Access isn't in front of `vite dev`, so DEV_USER_EMAIL (set in .dev.vars) stands in, and only on localhost. */
export function devMember(request: Request, env: Env): Member | null {
  const host = new URL(request.url).hostname
  if (!env.DEV_USER_EMAIL || (host !== 'localhost' && host !== '127.0.0.1')) return null
  const email = env.DEV_USER_EMAIL.toLowerCase()
  return { email, role: roleFor(email, env.ADMIN_EMAIL) }
}

export const isWrite = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method)

export const isJson = (contentType: string | undefined) => contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json'
