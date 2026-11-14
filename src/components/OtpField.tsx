import { useRef, useState, type ChangeEvent, type MouseEvent } from 'react'

const codeLength = 6

function normalizeCode(value: string) {
  return value
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/\D/g, '').slice(0, codeLength)
}

export function OtpField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const slots = useRef<HTMLSpanElement>(null)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const start = Math.min(selection.start, value.length)
  const end = Math.min(selection.end, value.length)
  const caretSlot = start === end ? Math.min(start, codeLength - 1) : -1

  function readSelection(input: HTMLInputElement) {
    setSelection({ start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 })
  }

  function change(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const raw = input.value
    const normalized = normalizeCode(raw)
    if (raw !== normalized) {
      const nextStart = normalizeCode(raw.slice(0, input.selectionStart ?? raw.length)).length
      const nextEnd = normalizeCode(raw.slice(0, input.selectionEnd ?? raw.length)).length
      const direction = input.selectionDirection ?? 'none'
      input.value = normalized
      input.setSelectionRange(nextStart, nextEnd, direction)
    }
    readSelection(input)
    onChange(normalized)
  }

  function placeCaret(event: MouseEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const bounds = slots.current?.getBoundingClientRect()
    // Keep native selection for drag, long press and multiple clicks.
    if (event.detail === 1 && input.selectionStart === input.selectionEnd && bounds?.width) {
      const position = (event.clientX - bounds.left) / (bounds.width / codeLength)
      const slot = position >= codeLength - 0.25 ? codeLength : Math.floor(position)
      const index = Math.max(0, Math.min(value.length, slot))
      input.setSelectionRange(index, index)
    }
    readSelection(input)
  }

  return (
    <label className="auth-field auth-otp-field">
      <span>کد تأیید ۶ رقمی</span>
      <span className="auth-otp-control" dir="ltr">
        <input
          autoFocus
          autoComplete="one-time-code"
          dir="ltr"
          disabled={disabled}
          inputMode="numeric"
          onChange={change}
          onClick={placeCaret}
          onFocus={event => readSelection(event.currentTarget)}
          onSelect={event => readSelection(event.currentTarget)}
          value={value}
        />
        <span aria-hidden="true" className="auth-otp-slots" ref={slots}>
          {Array.from({ length: codeLength }, (_, index) => (
            <span className="auth-otp-slot" data-selected={start <= index && index < end || undefined} key={index}>
              {value[index] ?? <span className="auth-otp-dash" />}
              {caretSlot === index && (
                <span className="auth-otp-caret" data-end={start === codeLength || undefined} />
              )}
            </span>
          ))}
        </span>
      </span>
    </label>
  )
}
