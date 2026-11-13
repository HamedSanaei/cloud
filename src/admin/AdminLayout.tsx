import { ClipboardList, Gauge, HardDrive, Home, LogOut, ShieldCheck, Users, XCircle, Globe, LifeBuoy, Settings2, Moon, Sun } from 'lucide-react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { AuthPage } from '../pages/AuthPages'
import { useAuth } from '../auth/AuthContext'
import { useTheme } from '../hooks/useTheme'
import { BRAND_NAME, BrandMark } from '../components/Brand'
import './admin.css'

const nav = [
  { to: '/admin', label: 'نمای کلی', icon: Gauge, end: true },
  { to: '/admin/orders', label: 'سفارش‌ها', icon: ClipboardList, end: false },
  { to: '/admin/users', label: 'کاربران', icon: Users, end: false },
  { to: '/admin/servers', label: 'سرورها', icon: HardDrive, end: false },
  { to: '/admin/datacenters', label: 'دیتاسنترها', icon: Globe, end: false },
  { to: '/admin/tickets', label: 'تیکت‌ها', icon: LifeBuoy, end: false },
  { to: '/admin/settings', label: 'تنظیمات فروشگاه', icon: Settings2, end: false },
] as const

const breadcrumb = (path: string) => path.startsWith('/admin/orders')
  ? 'سفارش‌ها' : path.startsWith('/admin/users')
    ? 'کاربران' : path.startsWith('/admin/servers')
      ? 'سرورها' : path.startsWith('/admin/datacenters') ? 'دیتاسنترها' : path.startsWith('/admin/tickets') ? 'تیکت‌ها' : path.startsWith('/admin/settings') ? 'تنظیمات فروشگاه' : 'نمای کلی'

export function AdminLayout() {
  const [dark, setDark] = useTheme()
  const { user, loading, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  if (loading) return <div className="route-loader" role="status"><span /><p>در حال بررسی دسترسی مدیر…</p></div>
  if (!user) return <AuthPage intent="login" adminEntry />
  if (user.role !== 'admin' || user.status !== 'active') {
    return (
      <main className="admin-denied" dir="rtl">
        <div className="admin-denied__card">
          <XCircle size={38} aria-hidden="true" />
          <h1>دسترسی به پنل مدیریت مجاز نیست</h1>
          <p>این بخش مخصوص حساب‌های مدیر فعال است. نقش حساب شما اجازه مشاهده اطلاعات سایر کاربران را نمی‌دهد.</p>
          <Link className="admin-primary-link" to="/dashboard"><Home size={17} /> بازگشت به ناحیه کاربری</Link>
        </div>
      </main>
    )
  }
  const onLogout = async () => {
    await logout()
    navigate('/admin', { replace: true })
  }
  return (
    <div className="admin-shell" dir="rtl">
      <aside className="admin-sidebar" aria-label="ناوبری پنل مدیریت">
        <Link className="admin-brand" to="/admin">
          <span className="admin-brand__mark"><BrandMark /></span>
          <span><strong>{BRAND_NAME}</strong><small>پنل مدیریت</small></span>
        </Link>
        <p className="admin-sidebar__caption">مدیریت</p>
        <nav className="admin-sidebar__links">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}
              className={({ isActive }) => `admin-nav-link ${isActive ? 'admin-nav-link--active' : ''}`}>
              <Icon size={19} strokeWidth={1.85} /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="admin-sidebar__bottom">
          <div className="admin-sidebar__role"><ShieldCheck size={19} /><span><strong>مدیر سامانه</strong><small>دسترسی مدیریتی</small></span></div>
          <Link className="admin-sidebar__exit" to="/dashboard"><Home size={17} /> ناحیه کاربری</Link>
          <button className="admin-sidebar__exit" type="button" onClick={() => void onLogout()}><LogOut size={17} /> خروج</button>
        </div>
      </aside>
      <div className="admin-shell__main">
        <header className="admin-topbar">
          <div className="admin-topbar__breadcrumb">{BRAND_NAME} <span>/</span> مدیریت <span>/</span> {breadcrumb(location.pathname)}</div>
          <button className="icon-button" aria-label={dark ? 'فعال‌سازی حالت روشن' : 'فعال‌سازی حالت تاریک'} onClick={() => setDark(value => !value)}>{dark ? <Sun size={20} /> : <Moon size={20} />}</button>
          <div className="admin-topbar__account"><span className="admin-topbar__avatar"><ShieldCheck size={17} /></span><span>حساب مدیر</span></div>
        </header>
        <main className="admin-main"><Outlet /></main>
      </div>
      <nav className="admin-bottom-nav" aria-label="ناوبری موبایل پنل مدیریت">
        {nav.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `admin-bottom-nav__link ${isActive ? 'is-active' : ''}`}>
            <Icon size={21} strokeWidth={1.7} /><span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
