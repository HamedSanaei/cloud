export const accountRoles = ['user', 'admin', 'super_admin'] as const
export type AccountRole = typeof accountRoles[number]

type AccountAccess = { role: AccountRole; status: string }

export const isActiveAdmin = (account: AccountAccess | null | undefined) =>
  account?.status === 'active' && (account.role === 'admin' || account.role === 'super_admin')

export const isSuperAdmin = (account: AccountAccess | null | undefined) =>
  account?.status === 'active' && account.role === 'super_admin'
