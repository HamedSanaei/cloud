import { Menu, Moon, Search, Sun, UserRound, WalletCards, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { accountLinks, allSearchItems } from '../../data/navigation'
import { useApiQuery } from '../../hooks/useApiQuery'
import { getWalletSummary } from '../../lib/endpoints'
import { formatToman } from '../../lib/format'
import { useAuth } from '../../auth/AuthContext'
import { BRAND_NAME } from '../Brand'
import { useTheme } from '../../hooks/useTheme'
import { NotificationCenter } from './NotificationCenter'

export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [dark, setDark] = useTheme()
  const searchRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const wallet = useApiQuery(getWalletSummary)
  const refreshWallet = wallet.refetch
  const { user } = useAuth()

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      refreshWallet()
    }
    const timer = window.setInterval(refresh, 60000)
    window.addEventListener('focus', refresh)
    window.addEventListener('integration-changed', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('integration-changed', refresh) }
  }, [refreshWallet])

  useEffect(() => {
    const closeMenus = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) setSearchOpen(false)
    }
    window.addEventListener('mousedown', closeMenus)
    return () => window.removeEventListener('mousedown', closeMenus)
  }, [])

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('fa')
    if (!normalized) return allSearchItems.slice(0, 6)
    return allSearchItems.filter((item) =>
      [item.label, ...(item.keywords ?? [])].join(' ').toLocaleLowerCase('fa').includes(normalized),
    ).slice(0, 7)
  }, [query])

  const goTo = (path: string) => {
    navigate(path)
    setSearchOpen(false)
    setQuery('')
  }


  return (
    <header className="topbar">
      <button type="button" className="icon-button topbar__menu" onClick={onOpenSidebar} aria-label="باز کردن منو">
        <Menu size={22} />
      </button>

      <div className="global-search" ref={searchRef}>
        <Search size={19} />
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setSearchOpen(true) }}
          onFocus={() => setSearchOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && results[0]) goTo(results[0].path)
            if (event.key === 'Escape') setSearchOpen(false)
          }}
          placeholder="جستجوی منو، سرور، کیف پول، IP..."
          aria-label="جستجوی سراسری"
        />
        {query ? <button type="button" onClick={() => setQuery('')} aria-label="پاک کردن جستجو"><X size={16} /></button> : null}
        {searchOpen ? (
          <div className="search-results">
            <span className="search-results__label">{query ? 'نتایج جستجو' : 'دسترسی سریع'}</span>
            {results.length ? results.map(({ label, path, icon: Icon }) => (
              <button type="button" key={path} onClick={() => goTo(path)}>
                <Icon size={18} />
                <span>{label}</span>
              </button>
            )) : <p>نتیجه‌ای پیدا نشد.</p>}
          </div>
        ) : null}
      </div>

      <Link to="/wallet" className="wallet-summary">
        <WalletCards size={19} />
        <span><small>کیف پول پیش‌فرض</small><strong>{wallet.loading ? '...' : wallet.error || !wallet.data ? 'دریافت نشد' : formatToman(wallet.data.totalBalance)}</strong></span>
      </Link>

      <div className="topbar__actions">
        <button type="button" className="icon-button" onClick={() => setDark((value) => !value)} aria-label={dark ? 'فعال‌سازی حالت روشن' : 'فعال‌سازی حالت تاریک'}>
          {dark ? <Sun size={20} /> : <Moon size={20} />}
        </button>
        {user && <NotificationCenter key={user.id} userId={user.id} />}
        <div className="menu-anchor">
          <button type="button" className="avatar-button" onClick={() => setProfileOpen((value) => !value)} aria-label="منوی کاربری" aria-expanded={profileOpen} aria-controls="profile-menu">{(user?.firstName || user?.email || 'ک').slice(0, 1)}</button>
          {profileOpen ? (
            <div className="popover popover--profile" id="profile-menu">
              <div className="popover__user"><UserRound size={20} /><span><strong>{[user?.firstName, user?.lastName].filter(Boolean).join(' ') || `کاربر ${BRAND_NAME}`}</strong><small>{user?.email || user?.mobile || 'حساب کاربری'}</small></span></div>
              {accountLinks.map(({ label, path, icon: Icon }) => (
                <Link key={path} to={path} onClick={() => setProfileOpen(false)}><Icon size={17} />{label}</Link>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}
