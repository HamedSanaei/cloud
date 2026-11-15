import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Read the production declarations: palette changes must keep both themes legible.
const themeCss = readFileSync('src/styles.css', 'utf8')
const listCss = readFileSync('src/server-management.css', 'utf8')
function declarations(css: string, selector: string) {
  const block = css.slice(css.indexOf(`${selector} {`) + selector.length + 2).split('}')[0]
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]))
}
function palette(dark: boolean) {
  const tokens = { ...declarations(themeCss, ':root'), ...(dark ? declarations(themeCss, ":root[data-theme='dark']") : {}),
    ...declarations(listCss, '.server-list-page'), ...(dark ? declarations(listCss, ":root[data-theme='dark'] .server-list-page") : {}) }
  function resolve(value: string): string { return value.startsWith('var(') ? resolve(tokens[value.slice(4, -1)]) : value }
  return (token: string) => resolve(tokens[token])
}
function luminance(hex: string) {
  const normalized = hex.length === 4 ? `#${[...hex.slice(1)].map(c => c + c).join('')}` : hex
  const rgb = [1, 3, 5].map(index => parseInt(normalized.slice(index, index + 2), 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0] + .05) / (values[1] + .05)
}
describe.each([false, true])('server list WCAG AA (dark=%s)', dark => {
  const p = palette(dark)
  const textPairs = [
    ['--ink', '--surface'], ['--ink', '--surface-muted'], ['--muted', '--surface'], ['--muted', '--surface-muted'],
    ['--server-action-ink', '--server-action-surface'], ['--server-action-ink', '--surface'],
    ['--server-success-ink', '--success-soft'], ['--danger-ink', '--danger-soft'],
    ['--server-warning-ink', '--warning-soft'], ['--server-neutral-ink', '--surface-muted'],
  ]
  it.each(textPairs)('keeps %s on %s at least 4.5:1', (ink, surface) => expect(contrast(p(ink), p(surface))).toBeGreaterThanOrEqual(4.5))
  it.each(['--surface', '--surface-muted', '--server-action-surface'])('keeps meaningful control boundaries and keyboard focus visible on %s', surface => {
    expect(contrast(p('--muted'), p(surface))).toBeGreaterThanOrEqual(3)
    expect(contrast(p('--server-focus'), p(surface))).toBeGreaterThanOrEqual(3)
  })
  it('keeps primary button labels and hover labels legible', () => {
    expect(contrast('#ffffff', p('--brand-500'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', p('--brand-600'))).toBeGreaterThanOrEqual(4.5)
  })
})
