import { AlertTriangle, Inbox, UserRoundCheck, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { LinkButton } from './Button'
import { Card } from './Card'

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  compact = false,
}: {
  title: string
  description?: string
  icon?: LucideIcon
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={`empty-state ${compact ? 'empty-state--compact' : ''}`}>
      <span className="empty-state__icon"><Icon size={compact ? 28 : 38} /></span>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  )
}

export function ProfileGuard({ compact = false }: { compact?: boolean }) {
  return (
    <Card className={`profile-guard ${compact ? 'profile-guard--compact' : ''}`} padding="lg">
      <span className="profile-guard__warning"><AlertTriangle size={42} /></span>
      <h2>تکمیل پروفایل کاربری</h2>
      <div className="profile-guard__notice">
        برای استفاده از این بخش باید پروفایل کاربری خود را تکمیل کنید. برای تکمیل اطلاعات روی دکمه زیر کلیک کنید.
      </div>
      <div className="profile-guard__requirements">
        <strong>اطلاعات مورد نیاز جهت استفاده از خدمات پنل:</strong>
        <ul>
          <li>نام و نام خانوادگی</li>
          <li>شماره همراه معتبر</li>
          <li>احراز هویت کد ملی</li>
        </ul>
      </div>
      <LinkButton to="/profile/update" icon={<UserRoundCheck size={19} />}>تکمیل اطلاعات کاربری</LinkButton>
    </Card>
  )
}

export function LoadingState({ label = 'در حال بارگذاری...' }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  )
}
