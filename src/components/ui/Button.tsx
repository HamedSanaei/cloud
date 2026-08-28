import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'

type ButtonVariant = 'primary' | 'secondary' | 'success' | 'danger' | 'ghost'
type ButtonSize = 'sm' | 'md' | 'lg'

interface CommonProps {
  children: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  iconPosition?: 'start' | 'end'
  fullWidth?: boolean
  className?: string
}

type ButtonProps = CommonProps & ButtonHTMLAttributes<HTMLButtonElement>

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  icon,
  iconPosition = 'start',
  fullWidth,
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`button button--${variant} button--${size} ${fullWidth ? 'button--full' : ''} ${className}`}
      {...props}
    >
      {icon && iconPosition === 'start' ? icon : null}
      <span>{children}</span>
      {icon && iconPosition === 'end' ? icon : null}
    </button>
  )
}

interface LinkButtonProps extends CommonProps {
  to: string
  onClick?: () => void
}

export function LinkButton({
  to,
  children,
  variant = 'primary',
  size = 'md',
  icon,
  iconPosition = 'start',
  fullWidth,
  className = '',
  onClick,
}: LinkButtonProps) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={`button button--${variant} button--${size} ${fullWidth ? 'button--full' : ''} ${className}`}
    >
      {icon && iconPosition === 'start' ? icon : null}
      <span>{children}</span>
      {icon && iconPosition === 'end' ? icon : null}
    </Link>
  )
}
