import type { MiddlewareHandler } from 'hono'
import type { Role } from './auth'

// "Setup needed": a feature declares the configuration it can't run without. While any of it is missing the feature is
// off, the Admin is told what to set up and how, and Members get a neutral message. Everything else keeps working
// (README: Upgrading). Messages are written from the declarations below, never from the missing values, so a secret
// can't reach a response.

/** A Worker secret or variable that a feature needs. */
export type Requirement = {
  env: keyof Env
  /** What it is, finishing "Setup needed: ...". */
  what: string
  /** The action to take, as a sentence. */
  how: string
}

export type Feature = {
  /** Stable and URL-safe: the browser and the API refer to the feature by this. */
  id: string
  /** What a Member calls it. */
  name: string
  requires: Requirement[]
  /** True when the product works fully without this feature (ADR 0008), so its setup is offered, not demanded. */
  optional?: boolean
}

export const AKAHU_SYNC: Feature = {
  id: 'akahu-sync',
  name: 'Akahu Sync',
  optional: true,
  requires: [
    { env: 'AKAHU_APP_TOKEN', what: 'the Akahu app token', how: 'Add it as the Worker secret AKAHU_APP_TOKEN.' },
    { env: 'AKAHU_USER_TOKEN', what: 'the Akahu user token', how: 'Add it as the Worker secret AKAHU_USER_TOKEN.' },
  ],
}

/** Every feature that can be switched off by missing configuration. A feature adds itself here. */
export const FEATURES: Feature[] = [AKAHU_SYNC]

const isSet = (value: unknown) => typeof value === 'string' && value.trim() !== ''

export const missingFor = (feature: Feature, env: Env): Requirement[] => feature.requires.filter((requirement) => !isSet(env[requirement.env]))

export type FeatureStatus = { id: string; name: string; enabled: boolean; message?: string }

export function featureStatuses(features: Feature[], env: Env, role: Role): FeatureStatus[] {
  return features.map((feature) => {
    const { id, name } = feature
    const missing = missingFor(feature, env)
    if (!missing.length) return { id, name, enabled: true }
    const setup = missing.map(({ what, how }) => `Setup needed: ${what}. ${how}`).join(' ')
    // An optional feature says so first, so an instance that doesn't use it knows it can ignore the rest.
    const message = role !== 'admin' ? `${name} isn't set up yet.` : feature.optional ? `Optional: you only need this to use ${name}. ${setup}` : setup
    return { id, name, enabled: false, message }
  })
}

/** Put in front of a feature's routes: while the feature isn't set up, they answer 503 and say nothing more. */
export const requireFeature =
  (feature: Feature): MiddlewareHandler<{ Bindings: Env }> =>
  async (c, next) => {
    if (missingFor(feature, c.env).length) return c.json({ error: 'Not set up', feature: feature.id }, 503)
    await next()
  }
