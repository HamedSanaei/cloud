import { Link } from 'react-router-dom'
import { useEffect } from 'react'
import { getIntegrationStatus } from '../../lib/platformClient'
import { useApiQuery } from '../../hooks/useApiQuery'

/** Integration status must never replace the page the user navigated to. */
export function IntegrationNotice() {
  const status = useApiQuery(getIntegrationStatus)
  const refetch = status.refetch
  useEffect(() => {
    window.addEventListener('integration-changed', refetch)
    return () => window.removeEventListener('integration-changed', refetch)
  }, [refetch])
  if (!status.data?.enabled || status.data.linked) return null
  return <aside className="integration-notice" role="note">
    <span>برای دسترسی به خدمات و موجودی مشترک، حساب تلگرام خود را متصل کنید.</span>
    <Link className="text-link" to="/settings/telegram">تنظیمات اتصال تلگرام</Link>
  </aside>
}
