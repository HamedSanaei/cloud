// Review ONLY the synthetic loopback preview in an already-running browser.
// No browser launch, headless session, production API, provider or customer account.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const endpoint = process.env.SERVER_LIST_CDP
assert.match(endpoint || '', /^http:\/\/127\.0\.0\.1:\d+$/, 'Set SERVER_LIST_CDP to the current browser; this script never launches one.')
const origin = 'http://127.0.0.1:5177'
const response = await fetch(origin)
assert.equal(response.headers.get('X-Design-Preview'), 'synthetic-fixtures-no-real-services')
const output = '.vite/server-list-review'
await mkdir(output, { recursive: true })
const browser = await chromium.connectOverCDP(endpoint)
const page = await browser.contexts()[0].newPage()
await page.bringToFront()
const results = []
async function checkContrast() {
  const checks = await page.locator('.server-table-row, .server-failure-panel').evaluateAll(roots => {
    const luminance = rgb => rgb.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0)
    const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number)
    return roots.flatMap(root => {
      const checks = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode, element = node.parentElement
        if (!node.textContent.trim() || !element.getClientRects().length || element.closest('[hidden]')) continue
        let background = element
        while (background && getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)') background = background.parentElement
        const ink = luminance(rgb(getComputedStyle(element).color)), surface = luminance(rgb(getComputedStyle(background || document.documentElement).backgroundColor))
        checks.push({ text: node.textContent.trim(), ratio: (Math.max(ink, surface) + .05) / (Math.min(ink, surface) + .05) })
      }
      return checks
    })
  })
  for (const check of checks) assert.ok(check.ratio >= 4.5, `${check.text}: ${check.ratio.toFixed(2)}:1`)
  return { count: checks.length, minimumRatio: Math.min(...checks.map(check => check.ratio)) }
}
try {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  // OS preference must work without a persisted appearance override.
  await page.addInitScript(() => localStorage.removeItem('cloud-server-theme'))
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(`${origin}/servers`)
      await page.locator('.server-table-row').nth(8).waitFor()
      await page.evaluate(() => document.fonts.ready)
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme)
      assert.equal(await page.locator('.server-table-row').count(), 9)
      const rows = await page.locator('.server-table-row').evaluateAll(elements => elements.map(element => ({
        height: element.getBoundingClientRect().height, background: getComputedStyle(element).backgroundColor, text: getComputedStyle(element).color,
      })))
      if (width < 640) {
        const geometry = await page.locator('.server-table-row').evaluateAll(elements => elements.map(element => ({ width: innerWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, scroll: element.scrollWidth, client: element.clientWidth })))
        for (const rect of geometry) { assert.ok(rect.left >= 0 && rect.right <= width, JSON.stringify(rect)); assert.ok(rect.scroll <= rect.client + 1, JSON.stringify(rect)) }
      }
      if (width === 1440) for (const row of rows) assert.ok(row.height >= 80 && row.height <= 90, `Primary row is ${row.height}px`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Page must not overflow horizontally')
      const card = page.locator('.server-list-page .card').filter({ has: page.locator('.server-table-row') })
      await card.screenshot({ path: `${output}/${theme}-${width}-compact.png` })
      const toggleId = await page.getByRole('button', { name: 'علت خطا و پیگیری', exact: true }).first().getAttribute('id')
      const toggle = page.locator(`[id="${toggleId}"]`)
      await toggle.focus()
      await toggle.press('Enter')
      await page.waitForFunction(id => document.getElementById(id)?.getAttribute('aria-expanded') === 'true', await toggle.getAttribute('id'))
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
      await page.getByRole('region', { name: 'جزئیات خطای ساخت سرور' }).waitFor()
      assert.ok(await page.getByText('مبلغ پرداخت‌شده به کیف پول بازگردانده شد.', { exact: true }).first().isVisible())
      const focus = await toggle.evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth }))
      assert.notEqual(focus.style, 'none')
      assert.notEqual(focus.width, '0px')
      await card.screenshot({ path: `${output}/${theme}-${width}-expanded.png` })
      const contrast = await checkContrast()
      if (width < 640) { await toggle.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${output}/${theme}-${width}-viewport.png` }) }
      await toggle.press('Space')
      await page.waitForFunction(id => document.getElementById(id)?.getAttribute('aria-expanded') === 'false', await toggle.getAttribute('id'))
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
      const search = page.getByPlaceholder('جستجو در سرورها...')
      await search.fill('failed-node-1')
      await page.waitForFunction(() => document.querySelectorAll('.server-table-row').length === 1)
      assert.equal(await page.locator('.server-table-row').count(), 1)
      results.push({ theme, width, rows, focus, contrast })
    }
  }
  await writeFile(`${output}/measurements.json`, JSON.stringify(results, null, 2))
  console.log(`PASS: ${results.length} current-browser light/dark desktop/mobile layouts; screenshots in ${output}`)
} finally {
  await page.close()
  await browser.close()
}
