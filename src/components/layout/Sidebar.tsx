import { Home, LogOut, Settings, X } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router-dom'
import { accountLinks, navGroups, settingsLinks } from '../../data/navigation'
import { useToast } from '../ui/Toast'
import { useAuth } from '../../auth/AuthContext'
import { BRAND_NAME, BrandMark } from '../Brand'

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { showToast } = useToast()
  const navigate = useNavigate()
  const { logout: endSession } = useAuth()

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
        onClick={onClose}
      />
      <aside className={`sidebar ${open ? 'sidebar--open' : ''}`}>
        <div className="sidebar__brand">
          <BrandMark className="brand-mark" />
          <div>
            <strong>{BRAND_NAME}</strong>
            <span className="sidebar__tagline">کنسول مدیریت زیرساخت</span>
          </div>
          <button type="button" className="icon-button sidebar__close" onClick={onClose} aria-label="بستن منو">
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
          <details className="sidebar-settings">
            <summary className="nav-item nav-item--compact"><Settings size={18} /><span>اتصال‌ها و مدیریت پنل</span></summary>
            {settingsLinks.map(({ label, path, icon: Icon }) => <NavLink to={path} key={path} onClick={onClose} className={({ isActive }) => `nav-item nav-item--compact ${isActive ? 'nav-item--active' : ''}`}><Icon size={17} /><span>{label}</span></NavLink>)}
          </details>
          <button type="button" className="nav-item nav-item--compact nav-item--danger" onClick={() => void logout()}>
            <LogOut size={18} />
            <span>خروج</span>
          </button>
        </div>

        <NavLink to="/changelog" className="sidebar__version" onClick={onClose}>نسخه ۱.۰.۰</NavLink>
      </aside>
    </>
  )
}
