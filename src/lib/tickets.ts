import type { TicketDepartment, TicketStatus } from './types'

export const ticketStatusLabels: Record<TicketStatus, string> = {
  pending: 'در انتظار',
  review: 'در حال بررسی',
  answered: 'پاسخ داده شده',
  closed: 'بسته شده',
}

export const ticketDepartmentLabels: Record<TicketDepartment, string> = {
  technical: 'فنی',
  finance: 'مالی',
  sales: 'فروش',
}

export const ticketStatusLabel = (status: string) => ticketStatusLabels[status as TicketStatus] ?? 'نامشخص'
export const ticketDepartmentLabel = (department: string) => ticketDepartmentLabels[department as TicketDepartment] ?? 'نامشخص'
