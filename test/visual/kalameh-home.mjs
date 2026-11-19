import assert from 'node:assert/strict'
import { preview } from 'vite'
import { chromium } from 'playwright-core'

const namedFace = process.env.KALAMEH_ORIGIN
const server = namedFace ? null : await preview({
  preview: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'serve-prerendered-home', configurePreviewServer(app) {
    app.middlewares.use((request, _response, next) => {
      const { pathname } = new URL(request.url, 'http://127.0.0.1')
      if (pathname === '/') request.url = '/home.html'
      if (pathname === '/hetzner') request.url = '/hetzner.html'
      next()
    })
  } }],
})
const origin = new URL(namedFace ?? server.resolvedUrls.local[0]).origin
let browser
try {
  browser = await chromium.launch({ channel: 'chrome' })
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const protocol = await page.context().newCDPSession(page)
    await protocol.send('Network.enable')
    await protocol.send('Network.setCacheDisabled', { cacheDisabled: true })
    await protocol.send('DOM.enable')
    await protocol.send('CSS.enable')
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort()
      if (!namedFace && url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: {} })
      return route.continue()
    })
    const fontResponse = page.waitForResponse(response => /\/kalameh\/[a-f0-9]{64}\/kalameh-bold\.woff2$/.test(response.url()))
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' })
    const font = await fontResponse
    assert.equal(font.status(), 200)
    assert.match((await font.headerValue('content-type')) ?? '', /^(?:font\/woff2|application\/font-woff2)/)
    assert.equal((await font.body()).subarray(0, 4).toString(), 'wOF2')
    await page.locator('.landing-home h1').waitFor()
    await page.waitForFunction(() => [...document.fonts].some(face => face.family.replace(/["']/g, '') === 'Kalameh' && face.weight === '700' && face.status === 'loaded'))
    const dimensions = await page.evaluate(async () => {
      await document.fonts.ready
      return { width: innerWidth, content: document.documentElement.scrollWidth }
    })
    assert.ok(dimensions.content <= dimensions.width, JSON.stringify(dimensions))
    const { root } = await protocol.send('DOM.getDocument')
    for (const selector of ['.landing-home h1', '.landing-home .hero-tagline', '.landing-home .hero-actions .button']) {
      const element = page.locator(selector).first()
      assert.match(await element.evaluate(el => getComputedStyle(el).fontFamily), /^Kalameh,/)
      const { nodeId } = await protocol.send('DOM.querySelector', { nodeId: root.nodeId, selector })
      const { fonts } = await protocol.send('CSS.getPlatformFontsForNode', { nodeId })
      assert.ok(fonts.some(face => face.isCustomFont && face.glyphCount > 0 && (!namedFace || /kalameh/i.test(face.familyName + face.postScriptName))))
    }
    for (const route of ['/hetzner', '/login', '/dashboard', '/admin']) {
      const requestedFonts = []
      const collect = request => { if (new URL(request.url()).pathname.startsWith('/kalameh/')) requestedFonts.push(request.url()) }
      page.on('request', collect)
      await page.goto(origin + route)
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      page.off('request', collect)
      assert.deepEqual(requestedFonts, [], route)
    }
    await page.close()
    console.log(`Homepage font delivery passed at ${width}px`)
  }
} finally {
  await browser?.close()
  if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
}
