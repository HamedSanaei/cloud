export const BRAND_NAME = 'پارس سرور'

export function BrandMark({ className = '' }: { className?: string }) {
  return <span className={`public-brand-mark ${className}`} aria-hidden="true"><i /><i /><i /></span>
}
