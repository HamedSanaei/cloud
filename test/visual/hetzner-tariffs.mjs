import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, define: { 'import.meta.env.VITE_API_BASE_URL': '"/api"' } })
let browser
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '')
  browser = await chromium.launch({ channel: 'chrome' })
  const places = [['fsn1', 'DE', 'Falkenstein'], ['nbg1', 'DE', 'Nuremberg'], ['ash', 'US', 'Ashburn'],
    ['hil', 'US', 'Hillsboro'], ['hel1', 'FI', 'Helsinki'], ['sin', 'SG', 'Singapore'], ['lon', 'GB', 'London']]
  const offers = Array.from({ length: 10 }, (_, group) => places.map(([location, country, city], index) => ({
    id: `${location}-${group}`, name: `CX ${location}-${group}`, location, country, city, vcpu: 2, memoryMb: 4096,
    diskGb: 40, diskType: 'Local', trafficGb: null, hourly: 123450 + index, monthly: 800000 + group,
  }))).flat()

  for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 760 }, hasTouch: width < 1024 })
    const visit = async control => width < 1024 ? control.tap() : control.click()
    let refreshed = false
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort()
      if (url.pathname === '/api/public/home-prices') return route.fulfill({ json: { data: {
        iran: null, hetzner: refreshed ? offers.map((offer, i) => i === 0 ? { ...offer, name: 'CX refreshed' } : offer) : offers,
        meta: { status: 'available', checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60000).toISOString(),
          catalogUpdatedAt: null, fxUpdatedAt: null },
      } } })
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: {} })
      return route.continue()
    })

    for (const path of ['/', '/hetzner']) {
      refreshed = false
      await page.goto(origin + path)
      const frame = page.locator('.tariff-scroll--hetzner')
      const head = frame.locator('thead'), table = frame.locator('table')
      const filters = page.getByRole('group', { name: 'کشور دیتاسنتر' })
      const germany = filters.getByRole('button', { name: 'آلمان' })
      await head.waitFor()
      if (width < 1024) await page.locator('.tariff-scroll--hetzner[data-page-sticky]').waitFor()
      assert.equal(await table.locator('tbody tr').count(), 70)
      assert.equal(await table.locator('thead').count(), 1)
      assert.equal(await head.getByRole('columnheader', { name: 'لوکیشن' }).count(), 1)
      const extraFlag = filters.getByRole('button', { name: 'بریتانیا' }).locator('.tariff-flag-emoji')
      assert.ok(await extraFlag.evaluate(async flag => {
        const fonts = await document.fonts.load('23px "Tariff Country Flags"', flag.textContent)
        return fonts.some(font => font.status === 'loaded')
      }))
      if (width === 1440) {
        await germany.hover()
        assert.equal(await germany.locator('.tariff-country-tip').evaluate(tip => getComputedStyle(tip).visibility), 'visible')
        await page.getByRole('heading', { name: 'تعرفه سرور هتزنر' }).hover()
        await germany.focus()
        assert.equal(await germany.locator('.tariff-country-tip').evaluate(tip => getComputedStyle(tip).visibility), 'visible')
        await page.keyboard.press('Enter')
      } else await visit(germany)
      assert.equal(await germany.getAttribute('aria-pressed'), 'true')
      assert.equal(await table.locator('tbody tr').count(), 20)

      const rowFlag = table.locator('summary[aria-label="آلمان"]').first()
      await visit(rowFlag)
      assert.equal(new URL(page.url()).pathname, path)
      assert.equal(await rowFlag.locator('.tariff-country-tip').evaluate(tip => getComputedStyle(tip).visibility), 'visible')
      await page.getByLabel('مقایسه از کم‌هزینه به بیشتر').selectOption('monthly')

      const scrollWithinTable = async () => {
        const top = await head.evaluate(row => row.getBoundingClientRect().top + window.scrollY)
        await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' }), top + 240)
        await page.waitForFunction(() => {
          const navbar = document.querySelector('.landing-header').getBoundingClientRect()
          const header = document.querySelector('.tariff-scroll--hetzner thead').getBoundingClientRect()
          return Math.abs(navbar.bottom - header.top) <= 2
        })
      }
      await scrollWithinTable()
      if (width < 1024) {
        const shifted = await frame.evaluate(element => {
          element.scrollLeft = -180
          const headers = [...element.querySelectorAll('thead th')]
          const row = [...element.querySelector('tbody tr').cells]
          return { scroll: element.scrollLeft, aligned: headers.every((cell, index) =>
            Math.abs(cell.getBoundingClientRect().left - row[index].getBoundingClientRect().left) < 1) }
        })
        assert.ok(shifted.scroll < 0 && shifted.aligned)
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)

      refreshed = true
      await page.evaluate(() => window.dispatchEvent(new Event('online')))
      await table.getByRole('link', { name: /CX refreshed/ }).waitFor({ state: 'attached' })
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      await scrollWithinTable()
      const bottom = await table.evaluate(element => element.getBoundingClientRect().bottom + window.scrollY)
      await page.evaluate(bottom => window.scrollTo({ top: bottom + 20, behavior: 'instant' }), bottom)
      await page.waitForFunction(() => {
        const navbar = document.querySelector('.landing-header').getBoundingClientRect()
        const header = document.querySelector('.tariff-scroll--hetzner thead').getBoundingClientRect()
        return header.bottom <= navbar.bottom + 2
      })
      assert.equal(await table.locator('thead').count(), 1)
    }
    await page.close()
    console.log(`PASS: / and /hetzner at ${width}px`)
  }
} finally {
  await browser?.close()
  await server.close()
}
