// Opt-in, current-browser review against a synthetic local RFB peer. No VPS calls.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import { detailServer, serverUxFixture } from '../server-management-fixtures.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const { WebSocketServer } = createRequire(new URL('../../backend/package.json', import.meta.url))('ws')
assert.match(process.env.SERVER_LIST_CDP || '', /^http:\/\/127\.0\.0\.1:\d+$/)
const keyEvents = [], wss = new WebSocketServer({ noServer: true })
const server = await createServer({
  define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/__console_fixture__') },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'console-fixture-only', configureServer(vite) {
    vite.middlewares.use('/__console_fixture__', (req, res) => {
      const path = (req.url || '/').split('?')[0]
      const data = path.endsWith('/console') ? { data: { grantId: 'synthetic-grant', password: 'unused-fixture', expiresAt: new Date(Date.now() + 90000).toISOString(), maxSessionSeconds: 300 } }
        : path.endsWith('/management') ? { data: { ...detailServer, capabilities: { ...detailServer.capabilities, console: true } } } : serverUxFixture(path)
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data))
    })
    vite.httpServer.on('upgrade', (req, socket, head) => {
      if (req.url?.includes('/console/synthetic-grant')) wss.handleUpgrade(req, socket, head, peer => wss.emit('connection', peer))
    })
  } }],
})
wss.on('connection', socket => {
  let phase = 0, frameSent = false, buffer = Buffer.alloc(0)
  socket.send(Buffer.from('RFB 003.008\n'))
  socket.on('message', data => {
    if (phase === 0) { phase++; socket.send(Buffer.from([1, 1])); return }
    if (phase === 1) { phase++; socket.send(Buffer.alloc(4)); return }
    if (phase === 2) {
      phase++
      const name = Buffer.from('Synthetic console 1280x800'), init = Buffer.alloc(24 + name.length)
      init.writeUInt16BE(1280, 0); init.writeUInt16BE(800, 2); init[4] = 32; init[5] = 24; init[7] = 1
      init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12); init[14] = 16; init[15] = 8
      init.writeUInt32BE(name.length, 20); name.copy(init, 24); socket.send(init); return
    }
    buffer = Buffer.concat([buffer, data])
    while (buffer.length) {
      const type = buffer[0], size = type === 0 ? 20 : type === 2 ? buffer.length < 4 ? Infinity : 4 + buffer.readUInt16BE(2) * 4
        : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6 : type === 6 ? buffer.length < 8 ? Infinity : 8 + buffer.readUInt32BE(4) : Infinity
      if (buffer.length < size) return
      if (type === 4) keyEvents.push({ down: buffer[1], key: buffer.readUInt32BE(4) })
      if (type === 3 && !frameSent) {
        frameSent = true
        const frame = Buffer.alloc(16 + 1280 * 800 * 4)
        frame.writeUInt16BE(1, 2); frame.writeUInt16BE(1280, 8); frame.writeUInt16BE(800, 10)
        for (let pixel = 16; pixel < frame.length; pixel += 4) { frame[pixel] = 58; frame[pixel + 1] = 36; frame[pixel + 2] = 23 }
        socket.send(frame)
      }
      buffer = buffer.subarray(size)
    }
  })
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.connectOverCDP(process.env.SERVER_LIST_CDP)
const page = await browser.contexts()[0].newPage()
try {
  await page.bringToFront()
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  await page.setViewportSize({ width: 1536, height: 687 })
  await page.goto(`${origin}/servers/${detailServer.id}?tab=console`)
  await page.getByRole('button', { name: 'ایجاد نشست موقت' }).click()
  const entry = page.getByRole('button', { name: 'ورود با صفحه‌کلید به کنسول' })
  await entry.waitFor()
  await entry.focus(); await page.keyboard.press('Enter')
  assert.equal(await page.locator('.server-console-viewer canvas').evaluate(canvas => document.activeElement === canvas), true)
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => document.activeElement?.tagName === 'CANVAS')
  await page.keyboard.press('Control+Alt+Escape')
  assert.equal(await entry.evaluate(element => document.activeElement === element), true)
  assert.ok(keyEvents.some(event => event.key === 0xff09), 'Tab reaches the guest')
  const canvas = page.locator('.server-console-viewer canvas'), initial = await canvas.boundingBox()
  await page.getByRole('button', { name: 'بزرگ‌کردن کنسول' }).click()
  await page.waitForFunction(() => document.querySelector('.server-console-viewer canvas').getBoundingClientRect().height > 400)
  const expanded = await canvas.boundingBox()
  assert.ok(expanded.width > initial.width && expanded.height > initial.height)
  assert.ok(expanded.width / 1280 > .6, 'Desktop expansion makes the guest substantially larger than 37.5%')
  await mkdir('.vite/console-review', { recursive: true })
  await page.screenshot({ path: '.vite/console-review/expanded-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '.vite/console-review/expanded-mobile.png', fullPage: true })
  for (const socket of wss.clients) socket.close(4008)
  await page.getByText('مهلت نشست موقت کنسول به پایان رسید. برای اتصال دوباره نشست جدید بسازید.', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'ایجاد نشست موقت' }).isEnabled(), true)
  console.log(`PASS: real noVNC synthetic peer; keyboard entry/guest Tab/escape, expanded ${Math.round(expanded.width)}x${Math.round(expanded.height)}, mobile bounds and proxy expiry.`)
} finally {
  await page.close(); await browser.close()
  for (const peer of wss.clients) peer.terminate()
  await new Promise(resolve => wss.close(resolve)); await server.close()
}
