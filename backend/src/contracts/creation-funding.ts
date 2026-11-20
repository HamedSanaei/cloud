export const defaultCreationCoverageDays = 7
export const maxCreationCoverageDays = 30

export function isCreationCoverageDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxCreationCoverageDays
}

export function minimumCreationPeriods(interval: string, days: number): number {
  if (interval === 'HOURLY') return days * 24
  if (interval === 'DAILY') return days
  return interval === 'MONTHLY' ? 1 : NaN
}
