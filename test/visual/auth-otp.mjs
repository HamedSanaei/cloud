import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const server = await createServer({
  define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/__otp_fixture__') },
  server: { host: '127.0.0.1', port: 0, hmr: false },
})

await server.listen()
try {
  const { port } = server.httpServer.address()
  const browser = await chromium.launch({ channel: process.env.OTP_BROWSER_CHANNEL || undefined })
  try {
    for (const width of [320, 360, 390, 1440]) {
      await test(`OTP layout and editing at ${width}px`, async () => {
        const mobile = width < 700
        const context = await browser.newContext({ viewport: { width, height: mobile ? 640 : 900 }, isMobile: mobile, hasTouch: mobile })
        try {
          const page = await context.newPage()
          const verified = []
          await page.route('**/__otp_fixture__/auth/**', route => {
            const path = new URL(route.request().url()).pathname
            if (path.endsWith('/me')) return route.fulfill({ status: 401, json: {} })
            if (path.endsWith('/phone/start')) return route.fulfill({ status: 202, json: { data: {
              challengeToken: 'sms', challengeType: 'sms', destination: '09123***789', expiresIn: 300, resendAfter: 45,
            } } })
            if (path.endsWith('/challenge/verify')) {
              verified.push(route.request().postDataJSON())
              return route.fulfill({ status: 202, json: { data: {
                challengeToken: 'totp', challengeType: 'totp', destination: '2FA', expiresIn: 300, resendAfter: 0,
              } } })
            }
            return route.abort()
          })

          await page.goto(`http://127.0.0.1:${port}/login`)
          await page.getByRole('tab', { name: 'شماره همراه' }).click()
          await page.getByPlaceholder('09123456789').fill('09000000000')
          await page.getByRole('button', { name: 'ارسال کد پیامکی' }).click()
          const input = page.getByRole('textbox', { name: 'کد تأیید ۶ رقمی' })
          await input.waitFor()

          const masked = page.getByText('09123***789')
          const maskedText = await masked.evaluate(element => ({
            paragraphDirection: getComputedStyle(element.parentElement).direction,
            numberDirection: getComputedStyle(element).direction,
            bidi: getComputedStyle(element).unicodeBidi,
            characterOffsets: Array.from(element.textContent, (_, index) => {
              const range = document.createRange()
              range.setStart(element.firstChild, index)
              range.setEnd(element.firstChild, index + 1)
              return range.getBoundingClientRect().left
            }),
          }))
          assert.equal(maskedText.paragraphDirection, 'rtl')
          assert.equal(maskedText.numberDirection, 'ltr')
          assert.equal(maskedText.bidi, 'isolate')
          const { characterOffsets } = maskedText
          assert.ok(characterOffsets.every((offset, index) => index === 0 || offset > characterOffsets[index - 1]))

          const control = await page.locator('.auth-otp-control').boundingBox()
          const slots = page.locator('.auth-otp-slot')
          assert.equal(await slots.count(), 6)
          const first = await slots.first().boundingBox()
          for (const slot of await slots.all()) {
            const box = await slot.boundingBox()
            const dash = await slot.locator('.auth-otp-dash').boundingBox()
            assert.ok(Math.abs(box.width - first.width) < 1)
            assert.ok(Math.abs(box.x + box.width / 2 - dash.x - dash.width / 2) < 1)
            assert.ok(dash.x - control.x > 12 && control.x + control.width - dash.x - dash.width > 12)
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)

          const caret = index => slots.nth(index).locator('.auth-otp-caret')
          assert.ok(await caret(0).isVisible())
          await page.keyboard.type('12345')
          assert.ok(await caret(5).isVisible())
          const second = await slots.nth(1).boundingBox()
          const x = second.x + second.width / 2
          const y = second.y + second.height / 2
          if (mobile) await page.touchscreen.tap(x, y)
          else await page.mouse.click(x, y)
          assert.equal(await input.evaluate(element => element.selectionStart), 1)
          assert.ok(await caret(1).isVisible())
          await page.keyboard.press('Shift+ArrowRight')
          await page.keyboard.press('Shift+ArrowRight')
          assert.equal(await page.locator('.auth-otp-slot[data-selected]').count(), 2)
          await page.keyboard.press('Delete')
          assert.equal(await input.inputValue(), '145')
          await page.keyboard.press('Backspace')
          assert.equal(await input.inputValue(), '45')
          assert.ok(await caret(0).isVisible())
          await page.keyboard.press('ControlOrMeta+a')
          await page.keyboard.insertText('۰۱-٢٣۴۵')
          await page.getByText('Google Authenticator یا برنامه مشابه').waitFor()
          assert.deepEqual(verified, [{ token: 'sms', code: '012345' }])
        } finally {
          await context.close()
        }
      })
    }
  } finally {
    await browser.close()
  }
} finally {
  await server.close()
}
