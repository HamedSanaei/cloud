import { ChevronDown, Search } from 'lucide-react'
import { useId } from 'react'
import type { InputHTMLAttributes, SelectHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string
  search?: boolean
}

export function Input({ label, hint, error, search, className = '', ...props }: InputProps) {
  const messageId = useId()
  const labelId = `${messageId}-label`
  const describedBy = [props['aria-describedby'], error || hint ? messageId : undefined].filter(Boolean).join(' ')
  return (
    <label className={`field ${className}`}>
      {label ? <span className="field__label" id={labelId}>{label}</span> : null}
      <span className={`input-wrap ${error ? 'input-wrap--error' : ''}`}>
        {search ? <Search size={18} aria-hidden="true" /> : null}
        <input className="input" {...props} aria-invalid={!!error || props['aria-invalid']} aria-describedby={describedBy || undefined}
          aria-labelledby={props['aria-labelledby'] ?? (label && !props['aria-label'] ? labelId : undefined)} />
      </span>
      {error ? <span className="field__error" id={messageId} role="alert">{error}</span> : hint ? <span className="field__hint" id={messageId}>{hint}</span> : null}
    </label>
  )
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  hint?: string
}

export function Select({ label, hint, className = '', children, ...props }: SelectProps) {
  return (
    <label className={`field ${className}`}>
      {label ? <span className="field__label">{label}</span> : null}
      <span className="select-wrap">
        <select className="select" {...props}>{children}</select>
        <ChevronDown size={17} aria-hidden="true" />
      </span>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="toggle-row">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`toggle ${checked ? 'toggle--active' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
      <span>{label}</span>
    </label>
  )
}
