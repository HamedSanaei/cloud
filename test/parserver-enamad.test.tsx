// @vitest-environment-options {"url":"https://parserver.ir"}
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../src/auth/AuthContext'
import { LandingPage } from '../src/pages/LandingPage'
import { ParserverEnamadSeal, PARSERVER_ENAMAD_HTML } from '../src/components/ParserverEnamadSeal'

const code = 'vjF6ISz8Uxq8wxJBmjcMt1su8BMySoWe'
const href = `https://trustseal.enamad.ir/?id=8381321&Code=${code}`
const imgSrc = `https://trustseal.enamad.ir/logo.aspx?id=8381321&Code=${code}`

afterEach(() => vi.restoreAllMocks())

describe('parserver eNamad seal', () => {
  it('keeps verification available after an image failure and retries the original official image', () => {
    const { container } = render(<ParserverEnamadSeal hostname="parserver.ir" />)
    const originalImage = container.querySelector('img')!
    fireEvent.error(originalImage)
    expect(screen.getByRole('status').textContent).toBe('تصویر اینماد بارگیری نشد.')
    const verification = screen.getByRole('link', { name: 'استعلام در سامانه اینماد' })
    expect(verification.getAttribute('href')).toBe(href)
    expect(verification.getAttribute('referrerpolicy')).toBe('origin')
    expect(verification.getAttribute('rel')).toBe('noopener')
    fireEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }))
    const retriedImage = container.querySelector('img')!
    expect(retriedImage).not.toBe(originalImage)
    expect(retriedImage.getAttribute('src')).toBe(imgSrc)
    expect(screen.getByRole('status').textContent).toBe('در حال بارگیری اینماد…')
    fireEvent.load(retriedImage)
    expect(screen.queryByRole('status')).toBeNull()
    expect((container.querySelector('.parserver-enamad-seal__image') as HTMLElement).hidden).toBe(false)
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).toBeNull()
  })

  it('detects cached image failures that happened before event listeners were attached', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0)
    render(<ParserverEnamadSeal hostname="www.parserver.ir" />)
    expect(screen.getByRole('status').textContent).toBe('تصویر اینماد بارگیری نشد.')
    expect(screen.getByRole('link', { name: 'استعلام در سامانه اینماد' }).getAttribute('href')).toBe(href)
  })

  it('shows an already-loaded cached official image without a failure notice', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(150)
    const { container } = render(<ParserverEnamadSeal hostname="parserver.ir" />)
    expect(screen.queryByRole('status')).toBeNull()
    expect((container.querySelector('.parserver-enamad-seal__image') as HTMLElement).hidden).toBe(false)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(imgSrc)
  })

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
