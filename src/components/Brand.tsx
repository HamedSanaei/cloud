export const BRAND_NAME = 'سرورهاب'

export function BrandMark({ className = '' }: { className?: string }) {
  return <span className={`public-brand-mark ${className}`} aria-hidden="true"><i /><i /><i /></span>
}
