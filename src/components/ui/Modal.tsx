import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.body.classList.add('modal-open')
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.classList.remove('modal-open')
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal__header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button type="button" className="icon-button" aria-label="بستن" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </section>
    </div>,
    document.body,
  )
}
