// Existing-browser review of synthetic fixtures only; no provider/account mutations.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { detailServer } from '../server-management-fixtures.mjs'
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
assert.match(process.env.SERVER_LIST_CDP || '', /^http:\/\/127\.0\.0\.1:\d+$/)
const origin = 'http://127.0.0.1:5176'
assert.equal((await fetch(origin)).headers.get('X-Design-Preview'), 'synthetic-fixtures-no-real-services')
const browser = await chromium.connectOverCDP(process.env.SERVER_LIST_CDP)
const page = await browser.contexts()[0].newPage(), mutations = []
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
      : detailServer } })
    if (url.pathname.endsWith('/metrics')) {
      assert.equal(deleted, false, 'Deleted overview must not request metrics')
      const hours = url.searchParams.get('window') === '24h' ? 24 : 1, start = Date.parse('2026-11-16T00:00:00Z') / 1000, step = hours === 24 ? 300 : 60
      const samples = (factor, offset) => Array.from({ length: hours * 3600 / step }, (_, i) => [start + i * step, i % 13 === 5 ? null : Math.round((Math.sin(i / 7) + 1.2) * factor + offset)])
      return route.fulfill({ json: { data: { start: new Date(start * 1000).toISOString(), end: new Date((start + hours * 3600) * 1000).toISOString(), step,
        series: { cpu: samples(25, 2), 'network.0.bandwidth.in': samples(100000, 1000), 'network.0.bandwidth.out': samples(30000, 500), 'disk.0.bandwidth.read': samples(15000, 200), 'disk.0.bandwidth.write': samples(10000, 100) } } } })
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
      await page.getByRole('combobox', { name: 'بازهٔ زمانی' }).selectOption('24h')
      await chart.getByRole('img').waitFor()
      await page.waitForFunction(() => document.querySelector('.server-chart-samples summary')?.textContent.includes('۲۸۸'))
      const bounds = await chart.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await chart.screenshot({ path: `.vite/monitoring-review/${theme}-${width}-24h.png` })
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
  console.log('PASS: current-browser 1h/24h light/dark desktop/mobile charts, matching legend colors, sample tables, historical overview and protection intent; no mutations.')
} catch (error) {
  await page.screenshot({ path: '.vite/monitoring-review/failure.png', fullPage: true })
  console.error(await page.evaluate(() => ({ url: location.href, state: document.readyState, scripts: [...document.scripts].map(script => script.src), root: document.getElementById('root')?.innerHTML.slice(0, 300) })))
  console.error((await page.locator('body').innerText()).slice(0, 2200))
  throw error
} finally { await page.close(); await browser.close() }
