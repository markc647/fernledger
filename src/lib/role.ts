import type { Role } from '@/generated/api/auth'

export type { Role }

export const roleLabel = (role: Role) => (role === 'admin' ? 'Admin' : 'Member (read-only)')
