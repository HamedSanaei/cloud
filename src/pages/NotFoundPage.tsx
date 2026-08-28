import { FileQuestion } from 'lucide-react'
import { LinkButton } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { EmptyState } from '../components/ui/States'

export function NotFoundPage() {
  return (
    <Card className="not-found-card">
      <EmptyState icon={FileQuestion} title="صفحه پیدا نشد" description="آدرس واردشده در این کنسول وجود ندارد." action={<LinkButton to="/dashboard">بازگشت به داشبورد</LinkButton>} />
    </Card>
  )
}
