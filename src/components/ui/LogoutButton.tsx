import type { ButtonHTMLAttributes, ReactNode } from 'react'
import './logout-button.css'

/** Shared visual semantics for logout/session revocation, including menu items. */
export function LogoutButton({ className = '', type = 'button', icon, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode }) {
  return <button type={type} className={`logout-action ${className}`} {...props}>{icon}{children}</button>
}
