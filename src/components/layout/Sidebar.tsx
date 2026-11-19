import { isActiveAdmin } from '../../../backend/src/contracts/account-role'
import { Home, LogOut, Settings, X } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { accountLinks, navGroups, settingsLinks } from '../../data/navigation'
import { useToast } from '../ui/Toast'
import { useAuth } from '../../auth/AuthContext'
import { useApiQuery } from '../../hooks/useApiQuery'
import { getIntegrationStatus } from '../../lib/platformClient'
import { BRAND_NAME, BrandMark } from '../Brand'
import { LogoutButton } from '../ui/LogoutButton'

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { showToast } = useToast()
  const navigate = useNavigate()
  const { logout: endSession, user } = useAuth()
  const integration = useApiQuery(getIntegrationStatus)
  const closeButton = useRef<HTMLButtonElement>(null)
  const focusClose = useCallback(() => closeButton.current?.focus({ preventScroll: true }), [])
  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(focusClose)
    return () => window.cancelAnimationFrame(frame)
  }, [open, focusClose])

  const logout = async () => {
    await endSession()
    showToast('از حساب کاربری خارج شدید.')
    onClose()
    navigate('/login', { replace: true })
  }

  return (
    <>
      <button
        type="button"
        className={`sidebar-backdrop ${open ? 'sidebar-backdrop--visible' : ''}`}
        aria-label="بستن منو"
        tabIndex={-1}
        onClick={onClose}
      />
      <aside id="main-sidebar" className={`sidebar ${open ? 'sidebar--open' : ''}`}
        onKeyDown={event => { if (open && event.key === 'Escape') onClose() }}
        onTransitionEnd={event => {
          if (open && event.target === event.currentTarget && event.propertyName === 'transform'
            && !event.currentTarget.contains(document.activeElement)) focusClose()
        }}>
        <div className="sidebar__brand">
          <BrandMark className="brand-mark" />
          <div>
            <strong>{BRAND_NAME}</strong>
            <span className="sidebar__tagline">کنسول مدیریت زیرساخت</span>
          </div>
          <button ref={closeButton} type="button" className="icon-button sidebar__close" onClick={onClose} aria-label="بستن منو">
            <X size={21} />
          </button>
        </div>

        <nav className="sidebar__nav" aria-label="منوی اصلی">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group__label">{group.label}</span>
              {group.items.map(({ label, path, icon: Icon }) => (
                <NavLink
                  to={path}
                  key={path}
                  onClick={onClose}
                  className={({ isActive }) => `nav-item ${isActive ? 'nav-item--active' : ''}`}
                >
                  <Icon size={19} strokeWidth={1.8} />
                  <span>{label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar__account">
          <NavLink to="/" end className="nav-item nav-item--compact" onClick={onClose}><Home size={18} /><span>صفحه اصلی سایت</span></NavLink>
          {accountLinks.map(({ label, path, icon: Icon }) => (
            <NavLink
              to={path}
              key={path}
              onClick={onClose}
              className={({ isActive }) => `nav-item nav-item--compact ${isActive ? 'nav-item--active' : ''}`}
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
          {isActiveAdmin(user) && <NavLink to="/admin" onClick={onClose} className="nav-item nav-item--compact"><Settings size={18} /><span>مدیریت سایت</span></NavLink>}
          {integration.data?.enabled && (
            <details className="sidebar-settings">
              <summary className="nav-item nav-item--compact"><Settings size={18} /><span>اتصال‌ها و مدیریت پلتفرم</span></summary>
              {settingsLinks.map(({ label, path, icon: Icon }) => <NavLink to={path} key={path} onClick={onClose} className={({ isActive }) => `nav-item nav-item--compact ${isActive ? 'nav-item--active' : ''}`}><Icon size={17} /><span>{label}</span></NavLink>)}
            </details>
          )}
          <LogoutButton className="nav-item nav-item--compact" onClick={() => void logout()}>
            <LogOut size={18} />
            <span>خروج</span>
          </LogoutButton>
        </div>

        <NavLink to="/changelog" className="sidebar__version" onClick={onClose}>نسخه ۱.۰.۰</NavLink>
      </aside>
    </>
  )
}
