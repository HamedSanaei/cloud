import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import { checkoutFixture } from '../fixtures.mjs'

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, define: { 'import.meta.env.VITE_API_BASE_URL': '"/api"' } })
let browser

try {
  await server.listen()
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '')
  browser = await chromium.launch({ channel: 'chrome' })
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 820 } })
    let checkedAt = '2026-11-19T14:13:00.000Z'
    let responseState = 'populated'
    let role = 'admin'
    await page.addInitScript(() => localStorage.setItem('cloud-server-theme', 'light'))
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort()
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { data: { id: 'admin-fixture', role, status: 'active' } } })
      if (url.pathname === '/api/admin/settings/capabilities') return route.fulfill({ json: { data: { allowed: role === 'super_admin', encryptionReady: false } } })
      if (url.pathname === '/api/admin/settings/gateway') return route.fulfill({ json: checkoutFixture('/admin/settings/gateway') })
      if (url.pathname === '/api/admin/settings/outbound') return route.fulfill({ json: { data: { revision: 'fixture', profiles: [], integrations: [] } } })
      if (url.pathname === '/api/admin/console/overview' && responseState === 'error') return route.fulfill({ status: 503, json: { error: { message: 'گزارش در دسترس نیست' } } })
      if (url.pathname === '/api/admin/console/overview') return route.fulfill({ json: { data: {
        source: 'website', checkedAt, overdue: 1, failedRenewals24h: 1, ordersNeedingAttention: 0,
        accounts: [{ role: 'user', status: 'active', count: 6 }, { role: 'admin', status: 'active', count: 1 }],
        orderCounts: { active: 5, failed: 1, refunded: 1 }, serverCounts: { active: 1, terminated: 4 },
        recentOrders: responseState === 'empty' ? [] : [{ id: 'o1', orderNumber: 'ORD-1', userName: 'آزمایشی', status: 'active', serverStatus: 'terminated', totalToman: 17100 }],
        finance: { initialRial: 171000, renewalRial: 1000, refundsRial: 5000, netRial: 206000, depositsRial: 350000,
          exceptionCount: 1, renewalMismatchCount: 0, exceptions: [{ id: 'o2', orderNumber: 'ORD-2', unreturned: true, debitRial: 39000, refundRial: 0, invoicedRial: 39000 }] },
      } } })
      return url.pathname.startsWith('/api/') ? route.fulfill({ status: 404, json: {} }) : route.continue()
    })
    await page.goto(origin + '/admin')
    for (const theme of ['light', 'dark']) {
      await page.getByRole('heading', { name: 'موارد نیازمند بررسی مالی' }).waitFor()
      await page.getByRole('row').filter({ hasText: 'ORD-1' }).getByText('حذف‌شده').waitFor()
      assert.equal(await page.locator('.admin-shell').evaluate(el => getComputedStyle(el).direction), 'rtl')
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (theme === 'light') await page.getByRole('button', { name: 'فعال‌سازی حالت تاریک' }).click()
    }
    checkedAt = '2026-11-19T14:23:00.000Z'
    await page.getByRole('button', { name: 'به‌روزرسانی' }).click()
    await page.locator(`time[datetime="${checkedAt}"]`).waitFor()
    responseState = 'error'
    await page.getByRole('button', { name: 'به‌روزرسانی' }).click()
    await page.getByRole('alert').getByRole('button', { name: 'تلاش دوباره' }).waitFor()
    responseState = 'empty'
    await page.getByRole('button', { name: 'تلاش دوباره' }).click()
    await page.getByText('هنوز سفارشی ثبت نشده است.').waitFor()
    await page.goto(origin + '/admin/settings/gateway')
    await page.getByRole('heading', { name: 'دسترسی مدیریت مجاز نیست' }).waitFor()
    role = 'super_admin'
    await page.reload()
    await page.getByRole('heading', { name: 'درگاه تاباپی' }).waitFor()
    await page.locator(width === 390 ? '.admin-bottom-nav' : '.admin-sidebar').getByRole('link', { name: 'تنظیمات فروشگاه' }).waitFor()
    const tabs = page.getByRole('navigation', { name: 'بخش‌های تنظیمات فروشگاه' })
    assert.equal(await tabs.getByRole('link').count(), 10)
    await tabs.getByRole('link', { name: 'شبکه و پراکسی خروجی' }).click()
    await page.getByRole('heading', { name: 'پراکسی جدید' }).waitFor()
    await page.close()
    console.log(`Admin overview passed at ${width}px, light and dark`)
  }
} finally {
  await browser?.close()
  await server.close()
}
