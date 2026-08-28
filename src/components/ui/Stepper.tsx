import { Check } from 'lucide-react'

export function Stepper({ steps, current = 0 }: { steps: string[]; current?: number }) {
  return (
    <ol className="stepper" aria-label="مراحل">
      {steps.map((step, index) => {
        const state = index < current ? 'complete' : index === current ? 'active' : 'upcoming'
        return (
          <li className={`stepper__item stepper__item--${state}`} key={step}>
            <span className="stepper__line" aria-hidden="true" />
            <span className="stepper__circle">{state === 'complete' ? <Check size={16} /> : index + 1}</span>
            <span className="stepper__label">{step}</span>
          </li>
        )
      })}
    </ol>
  )
}
