import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { OtpField } from '../src/components/OtpField'

function setup(value = '') {
  function Form() {
    const [code, setCode] = useState(value)
    return <OtpField value={code} onChange={setCode} />
  }
  const { container } = render(<Form />)
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'کد تأیید ۶ رقمی' })
  const slots = [...container.querySelectorAll('.auth-otp-slot')]
  return { input, slots }
}

describe('OTP input slots', () => {
  it('renders six empty slots and one accessible, autofill-enabled numeric field', () => {
    const { input, slots } = setup()
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(input.autocomplete).toBe('one-time-code')
    expect(input.inputMode).toBe('numeric')
    expect(input.dir).toBe('ltr')
    expect(slots).toHaveLength(6)
    expect(slots.every(slot => slot.querySelector('.auth-otp-dash') && slot.closest('[aria-hidden="true"]'))).toBe(true)
    expect(slots[0].querySelector('.auth-otp-caret')).toBeTruthy()
  })

  it('tracks all seven keyboard insertion points and selection', async () => {
    const { input, slots } = setup()
    const user = userEvent.setup()
    for (const [index, digit] of Array.from('123456').entries()) {
      await user.keyboard(digit)
      expect(input.selectionStart).toBe(index + 1)
      expect(slots[Math.min(index + 1, 5)].querySelector('.auth-otp-caret')).toBeTruthy()
    }
    expect(slots[5].querySelector('.auth-otp-caret')?.hasAttribute('data-end')).toBe(true)
    await user.keyboard('{Home}{ArrowRight}')
    expect(input.selectionStart).toBe(1)
    expect(slots[1].querySelector('.auth-otp-caret')).toBeTruthy()
    input.setSelectionRange(1, 3)
    fireEvent.keyUp(input, { key: 'ArrowRight', shiftKey: true })
    expect(slots.map(slot => slot.hasAttribute('data-selected'))).toEqual([false, true, true, false, false, false])
    expect(slots.every(slot => !slot.querySelector('.auth-otp-caret'))).toBe(true)
    await user.keyboard('{Delete}')
    expect(input.value).toBe('1456')
    expect(input.selectionStart).toBe(1)
    expect(slots[1].querySelector('.auth-otp-caret')).toBeTruthy()
    await user.keyboard('{Backspace}')
    expect(input.value).toBe('456')
    expect(slots[0].querySelector('.auth-otp-caret')).toBeTruthy()
  })

  it('places a tap at the slot index, clamped to the end of existing digits', () => {
    const { input, slots } = setup('123')
    vi.spyOn(slots[0].parentElement!, 'getBoundingClientRect').mockReturnValue(new DOMRect(12, 0, 180, 66))
    fireEvent.click(input, { detail: 1, clientX: 55 })
    expect(input.selectionStart).toBe(1)
    expect(slots[1].querySelector('.auth-otp-caret')).toBeTruthy()
    fireEvent.click(input, { detail: 1, clientX: 175 })
    expect(input.selectionStart).toBe(3)
    expect(slots[3].querySelector('.auth-otp-caret')).toBeTruthy()
  })

  it('places a tap after the sixth digit at the end of a full code', () => {
    const { input, slots } = setup('123456')
    vi.spyOn(slots[0].parentElement!, 'getBoundingClientRect').mockReturnValue(new DOMRect(12, 0, 180, 66))
    fireEvent.click(input, { detail: 1, clientX: 187 })
    expect(input.selectionStart).toBe(6)
    expect(slots[5].querySelector('.auth-otp-caret[data-end]')).toBeTruthy()
  })

  it('normalizes a localized paste without moving the caret past the inserted digits', async () => {
    const { input, slots } = setup('1256')
    const user = userEvent.setup()
    act(() => input.setSelectionRange(2, 2))
    await user.paste('۳-٤')
    expect(input.value).toBe('123456')
    expect(input.selectionStart).toBe(4)
    expect(slots[4].querySelector('.auth-otp-caret')).toBeTruthy()
    expect(slots.map(slot => slot.textContent).join('')).toBe('123456')
  })
})
