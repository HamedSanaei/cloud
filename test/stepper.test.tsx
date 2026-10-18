import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Stepper } from '../src/components/ui/Stepper'

const steps = ['دیتاسنتر', 'دوره پرداخت', 'منابع', 'سیستم عامل', 'کیف پول', 'تأیید']

describe('Stepper incoming connectors', () => {
  it('renders only the five connections between six stages, with none before the first', () => {
    const { container } = render(<Stepper steps={steps} />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(6)
    expect(items[0].querySelector('.stepper__line')).toBeNull()
    for (const item of items.slice(1)) expect(item.querySelector('.stepper__line')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelectorAll('.stepper__line')).toHaveLength(5)
  })

  it('marks only the incoming completed path and moves the current step when going back', () => {
    const { container, rerender } = render(<Stepper steps={steps} current={3} />)
    expect(container.querySelectorAll('.stepper__item--complete .stepper__line')).toHaveLength(2)
    expect(container.querySelectorAll('.stepper__item--active .stepper__line')).toHaveLength(1)
    expect(container.querySelectorAll('.stepper__item--upcoming .stepper__line')).toHaveLength(2)
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('سیستم عامل')
    rerender(<Stepper steps={steps} current={0} />)
    expect(container.querySelectorAll('.stepper__item--complete')).toHaveLength(0)
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('دیتاسنتر')
    expect(container.querySelectorAll('.stepper__item--upcoming .stepper__line')).toHaveLength(5)
  })

  it.each([{ labels: [] }, { labels: ['تأیید'] }])('does not draw a connector without adjacent stages ($labels)', ({ labels }) => {
    const { container } = render(<Stepper steps={labels} />)
    expect(container.querySelectorAll('.stepper__line')).toHaveLength(0)
  })
})
