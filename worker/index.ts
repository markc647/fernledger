import { authConfigFromEnv, authenticate, devMember, isWrite, type Member } from './auth'

export async function handleApi(request: Request, member: Member): Promise<Response> {
  if (isWrite(request.method) && member.role !== 'admin') {
    return Response.json({ error: 'Read-only' }, { status: 403 })
  }
  const { pathname } = new URL(request.url)
  if (pathname === '/api/me') return Response.json(member)
  return Response.json({ error: 'Not found' }, { status: 404 })
}

export default {
  async fetch(request, env) {
    const config = authConfigFromEnv(env)
    const member = devMember(request, env) ?? (config && (await authenticate(request, config)))
    if (!member) return Response.json({ error: 'Unauthorised' }, { status: 401 })
    return handleApi(request, member)
  },

  async scheduled(controller) {
    // Phase 3 (Sync) and Phase 7 (backup) hook in here, keyed on controller.cron.
    console.log('cron', controller.cron)
  },
} satisfies ExportedHandler<Env>
