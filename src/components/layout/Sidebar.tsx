import { LogOut, X } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { accountLinks, navGroups } from '../../data/navigation'

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
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
          <div className="brand-mark">م</div>
          <div>
            <strong>کلود سرور</strong>
            <span>کنسول مدیریت زیرساخت</span>
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
          <button type="button" className="nav-item nav-item--compact nav-item--danger">
            <LogOut size={18} />
            <span>خروج</span>
          </button>
        </div>

        <NavLink to="/changelog" className="sidebar__version" onClick={onClose}>نسخه ۱.۰.۰</NavLink>
      </aside>
    </>
  )
}
