import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ParserverEnamadSeal, PARSERVER_ENAMAD_HTML } from '../src/components/ParserverEnamadSeal'

const code = 'vjF6ISz8Uxq8wxJBmjcMt1su8BMySoWe'
const href = `https://trustseal.enamad.ir/?id=8381321&Code=${code}`
const imgSrc = `https://trustseal.enamad.ir/logo.aspx?id=8381321&Code=${code}`

describe('parserver eNamad seal', () => {
  it('preserves the exact official snippet and renders it on the domain', () => {
    const expected = `<a referrerpolicy='origin' target='_blank' href='${href}'><img referrerpolicy='origin' src='${imgSrc}' alt='' style='cursor:pointer' code='${code}'></a>`
    expect(PARSERVER_ENAMAD_HTML).toBe(expected)
    const { container } = render(<ParserverEnamadSeal hostname="parserver.ir" />)
    const link = container.querySelector('a')
    const img = container.querySelector('img')
    expect(link?.getAttribute('href')).toBe(href)
    expect(link?.getAttribute('referrerpolicy')).toBe('origin')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(img?.getAttribute('src')).toBe(imgSrc)
    expect(img?.getAttribute('code')).toBe(code)
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })

  it('does not show the seal on other hosted domains', () => {
    const { container } = render(<ParserverEnamadSeal hostname="cloud.tofanservice.ir" />)
    expect(container.querySelector('a')).toBeNull()
  })
})