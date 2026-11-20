import { lazy, Suspense, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { PublicPage } from './PublicPage'
import { isPublicPath, publicPages, PUBLIC_ORIGIN, shareImage } from './metadata'
import { getLegalDocument, LegalPage } from './LegalPage'

const authTitles = new Map([
  ['/login', 'ورود به حساب'],
  ['/register', 'ساخت حساب'],
  ['/forgot-password', 'بازیابی رمز عبور'],
])

// Public visitors do not download the complete authenticated dashboard/admin bundle.
const PrivateApp = lazy(() => import('../private-entry'))
export function RootRoutes({ initialTariffs, initialPath }: { initialTariffs?: string; initialPath: string }) {
  const { pathname } = useLocation()
  const legalDocument = getLegalDocument(pathname)
  useEffect(() => {
    const page = isPublicPath(pathname) ? publicPages[pathname] : null
    const title = legalDocument?.title ?? authTitles.get(pathname)
    document.title = page?.title ?? (title ? `${title} | پارس سرور` : 'پارس سرور — پنل مدیریت')
    const setMeta = (selector: string, attribute: string, name: string, value: string) => {
      let element = document.head.querySelector<HTMLMetaElement>(selector)
      if (!element) { element = document.createElement('meta'); element.setAttribute(attribute, name); document.head.append(element) }
      element.content = value
    }
    setMeta('meta[name="robots"]', 'name', 'robots', page ? 'index,follow' : 'noindex,follow')
    if (!page) { document.head.querySelector('link[rel="canonical"]')?.remove(); return }
    setMeta('meta[name="description"]', 'name', 'description', page.description)
    for (const [key, value] of Object.entries({ title: page.title, description: page.description, url: PUBLIC_ORIGIN + pathname, image: shareImage })) setMeta(`meta[property="og:${key}"]`, 'property', 'og:' + key, value)
    for (const [key, value] of Object.entries({ title: page.title, description: page.description, image: shareImage, card: 'summary_large_image' })) setMeta(`meta[name="twitter:${key}"]`, 'name', 'twitter:' + key, value)
    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
    if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.append(canonical) }
    canonical.href = PUBLIC_ORIGIN + pathname
  }, [pathname, legalDocument])
  if (legalDocument) return <LegalPage entry={legalDocument} />
  return isPublicPath(pathname) ? <PublicPage path={pathname} initialTariffs={pathname === initialPath ? initialTariffs : undefined} />
    : <Suspense fallback={<div className="route-loader" role="status">در حال بارگذاری پنل…</div>}><PrivateApp /></Suspense>
}
