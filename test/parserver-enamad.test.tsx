// @vitest-environment-options {"url":"https://parserver.ir"}
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../src/auth/AuthContext'
import { LandingPage } from '../src/pages/LandingPage'
import { ParserverEnamadSeal, PARSERVER_ENAMAD_HTML } from '../src/components/ParserverEnamadSeal'

const code = 'vjF6ISz8Uxq8wxJBmjcMt1su8BMySoWe'
const href = `https://trustseal.enamad.ir/?id=8381321&Code=${code}`
const imgSrc = `https://trustseal.enamad.ir/logo.aspx?id=8381321&Code=${code}`

describe('parserver eNamad seal', () => {
  it('places the official seal in its own footer column alongside the Pars Server brand and services', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    render(<MemoryRouter><AuthProvider><LandingPage /></AuthProvider></MemoryRouter>)
    const footer = screen.getByRole('contentinfo')
    expect(await within(footer).findByRole('link', { name: 'پارس سرور' })).toBeTruthy()
    expect(footer.textContent).toContain('© پارس سرور')
    expect(footer.textContent).not.toMatch(/سرور\s*هاب/)
    const columns = footer.querySelector('.public-container')!.children
    expect(columns[0].classList.contains('landing-footer-brand')).toBe(true)
    expect(columns[1]).toBe(within(footer).getByRole('navigation', { name: 'خدمات پارس سرور' }))
    expect(columns[2].classList.contains('landing-footer-trust')).toBe(true)
    expect(columns[2].querySelector('a')?.getAttribute('href')).toBe(href)
    expect(columns[0].querySelector('.parserver-enamad-seal')).toBeNull()
  })

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
