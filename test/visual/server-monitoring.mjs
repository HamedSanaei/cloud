// Browser review against the local synthetic preview.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { detailServer } from '../server-management-fixtures.mjs'
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const origin = 'http://127.0.0.1:5176'
assert.equal((await fetch(origin)).headers.get('X-Design-Preview'), 'synthetic-fixtures-no-real-services')
const cdp = process.env.SERVER_LIST_CDP
if (cdp) assert.match(cdp, /^http:\/\/127\.0\.0\.1:\d+$/)
const browser = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch({ channel: 'chrome' })
const context = cdp ? browser.contexts()[0] : await browser.newContext()
const page = await context.newPage(), mutations = []
const operationId = 'f07b9500-414e-4000-8000-000000000009'
const readyCredential = {
  ...detailServer,
  operations: [{ id: operationId, action: 'reset_password', status: 'confirmed', createdAt: '2026-11-16T08:00:00Z' }],
  credentials: [{ operationId, expiresAt: '2099-11-16T09:00:00Z' }],
}
let deleted = false
try {
  page.on('pageerror', error => console.error(error.message))
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  await page.bringToFront()
  await page.addInitScript(() => localStorage.removeItem('cloud-server-theme'))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (route.request().method() !== 'GET') { mutations.push(url.pathname); return route.abort() }
    if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: { data: { id: 'preview-user', role: 'user', firstName: 'آزمایشی', timezone: 'Asia/Tehran' } } })
    if (url.pathname.endsWith('/management')) return route.fulfill({ json: { data: deleted
      ? { ...detailServer, lifecycle: 'terminated', providerState: 'terminated', providerAvailable: false, facts: null, cpu: '1 vCPU', ram: '1024 MB', disk: '20 GB', datacenter: 'hel1' }
      : readyCredential } })
    if (url.pathname.endsWith('/metrics')) {
      assert.equal(deleted, false, 'Deleted overview must not request metrics')
      const hours = parseInt(url.searchParams.get('window') || '1h', 10), start = Date.parse('2026-11-16T00:00:00Z') / 1000, step = hours === 1 ? 60 : 300
      const samples = (factor, offset) => Array.from({ length: hours * 3600 / step }, (_, i) => [start + i * step, i % 13 === 5 ? null : Math.round((Math.sin(i / 7) + 1.2) * factor + offset)])
      return route.fulfill({ json: { data: { start: new Date(start * 1000).toISOString(), end: new Date((start + hours * 3600) * 1000).toISOString(), step,
        series: { cpu: samples(2, 0), 'network.0.bandwidth.in': samples(100000, 1000), 'network.0.bandwidth.out': samples(30000, 500), 'disk.0.bandwidth.read': samples(15000, 200), 'disk.0.bandwidth.write': samples(10000, 100) } } } })
    }
    return route.continue()
  })
  await mkdir('.vite/monitoring-review', { recursive: true })
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 })
      await page.goto(`${origin}/servers/${detailServer.id}?tab=monitoring`)
      const chart = page.locator('.server-chart').filter({ has: page.getByRole('heading', { name: 'Network (bytes/s)', exact: true }) })
      await chart.getByRole('img').waitFor()
      await chart.locator('summary').click()
      assert.equal(await chart.locator('thead th').count(), 3)
      assert.match(await chart.getByRole('img').getAttribute('aria-label'), /به وقت ایران/)
      const colors = await chart.evaluate(card => ({ plot: [...card.querySelectorAll('g[data-series]')].map(e => getComputedStyle(e).stroke), legend: [...card.querySelectorAll('.server-chart-legend line')].map(e => getComputedStyle(e).stroke) }))
      assert.deepEqual(colors.plot, colors.legend)
      await chart.screenshot({ path: `.vite/monitoring-review/${theme}-${width}-1h.png` })
      for (const [window, count] of [['6h', '۷۲'], ['24h', '۲۸۸']]) {
        await page.getByRole('combobox', { name: 'بازهٔ زمانی' }).selectOption(window)
        await chart.getByRole('img').waitFor()
        await page.waitForFunction(text => document.querySelector('.server-chart-samples summary')?.textContent.includes(text), count)
      }
      const cpu = page.locator('.server-chart').filter({ has: page.getByRole('heading', { name: 'CPU (%)', exact: true }) })
      const scale = cpu.getByRole('checkbox', { name: /نمای جزئی CPU/ })
      assert.equal(await scale.isChecked(), true)
      assert.ok(await cpu.locator('path').count() > 1, 'Samples must preserve gaps in the chart')
      await scale.uncheck()
      assert.match(await cpu.locator('.server-chart-scale').innerText(), /۱۰۰/)
      const contrast = await cpu.locator('.server-chart-stats').evaluate(stats => {
        const luminance = color => color.match(/\d+/g).slice(0, 3).map(Number).reduce((sum, channel, index) => {
          const value = channel / 255
          return sum + [0.2126, 0.7152, 0.0722][index] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        }, 0)
        const fg = luminance(getComputedStyle(stats).color), bg = luminance(getComputedStyle(stats.closest('.server-chart')).backgroundColor)
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
      })
      assert.ok(contrast >= 4.5, `CPU stats contrast was ${contrast}`)
      const bounds = await chart.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await chart.screenshot({ path: `.vite/monitoring-review/${theme}-${width}-24h.png` })
      await page.goto(`${origin}/servers/${detailServer.id}?tab=access`)
      const access = page.locator('.server-root-credential')
      const reset = await access.getByRole('button', { name: 'بازنشانی رمز عبور', exact: true }).boundingBox()
      const warning = await access.locator('.server-notice').boundingBox()
      assert.ok(warning.y - reset.y - reset.height >= 12)
      await access.getByRole('button', { name: /دریافت امن رمز/ }).click()
      const dialog = page.getByRole('dialog')
      assert.equal(await dialog.getByText(operationId).evaluate(id => getComputedStyle(id).direction), 'ltr')
      assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await dialog.getByRole('button', { name: 'بستن' }).click()
    }
  }
  deleted = true
  await page.goto(`${origin}/servers/${detailServer.id}`)
  await page.getByText(/مشخصات تاریخی \/ آخرین اطلاعات ثبت‌شده/).waitFor()
  for (const text of ['1 vCPU', '1024 MB', '20 GB']) assert.ok(await page.getByText(text, { exact: true }).isVisible())
  deleted = false
  await page.goto(`${origin}/servers/${detailServer.id}?tab=network`)
  for (const [button, intent] of [['تغییر حفاظت حذف', 'فعال‌سازی حفاظت حذف'], ['تغییر حفاظت Rebuild', 'فعال‌سازی حفاظت نصب مجدد (Rebuild)']]) {
    await page.getByRole('button', { name: button }).click()
    const dialog = page.getByRole('dialog')
    assert.ok(await dialog.getByRole('heading', { name: intent, exact: true }).isVisible())
    assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false, 'Protection dialog must not clip its action label')
    await dialog.screenshot({ path: `.vite/monitoring-review/protection-${button.includes('Rebuild') ? 'rebuild' : 'delete'}.png` })
    await dialog.getByRole('button', { name: 'انصراف' }).click()
  }
  assert.deepEqual(mutations, [])
  console.log('PASS: 1h/6h/24h charts and root password layout in light/dark desktop/mobile. No mutations.')
} catch (error) {
  await page.screenshot({ path: '.vite/monitoring-review/failure.png', fullPage: true })
  console.error(await page.evaluate(() => ({ url: location.href, state: document.readyState, scripts: [...document.scripts].map(script => script.src), root: document.getElementById('root')?.innerHTML.slice(0, 300) })))
  console.error((await page.locator('body').innerText()).slice(0, 2200))
  throw error
} finally { await page.close(); await browser.close() }
