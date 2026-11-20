// HTTP/HTML verification, not a headless browser. Only disposable labeled fixtures.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { renderHomeTariffs } from '../backend/src/contracts/home-tariffs.ts'

const id = 'public-seo-' + randomUUID(), image = process.env.PUBLIC_SMOKE_IMAGE || 'tofan-cloud:ci'
const tmp = await mkdtemp(path.join(os.tmpdir(), 'public-seo-'))
function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000, windowsHide: true })
  if (!allowFailure && result.status !== 0) throw new Error(result.stdout + result.stderr)
  return result.stdout.trim()
}
const label = ['--label', `parserver.seo-test=${id}`]
const meta = { status: 'available', checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60000).toISOString(), catalogUpdatedAt: new Date().toISOString(), fxUpdatedAt: new Date().toISOString() }
const offers = [{ id: 'fixture-plan', name: 'CX-HTTP-fixture', location: 'hel1', country: 'FI', city: 'Helsinki', vcpu: 2, memoryMb: 4096, diskGb: 40, diskType: 'Local',
  trafficGb: 21990, includedTrafficBytes: 20 * 2 ** 40, hourly: 123450, monthly: 6789000,
  trafficOverage: { perTbRial: 333450, includedBytes: 20 * 2 ** 40, source: 'hetzner-server-type-location',
    observedAt: meta.catalogUpdatedAt, fxAt: meta.fxUpdatedAt, ruleVersion: meta.checkedAt } }]
try {
  const all = renderHomeTariffs(null, offers, meta), hetzner = renderHomeTariffs(null, offers, meta, 'hetzner')
  await writeFile(path.join(tmp, 'api.mjs'), `import {createServer} from 'node:http'; createServer((req,res)=>{if(req.headers.cookie||req.headers.authorization){res.writeHead(500);res.end('Private headers forwarded');return}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url.includes('scope=hetzner')?${JSON.stringify(hetzner)}:${JSON.stringify(all)})}).listen(8000,'0.0.0.0');`)
  docker(['network', 'create', ...label, id])
  docker(['run', '-d', '--name', id + '-api', ...label, '--network', id, '--network-alias', 'cloud-api', '--mount', `type=bind,src=${tmp},dst=/fixture,readonly`, 'node:24-alpine', 'node', '/fixture/api.mjs'])
  docker(['run', '-d', '--name', id + '-web', ...label, '--network', id, '-p', '127.0.0.1::80', image])
  const port = docker(['port', id + '-web', '80/tcp']).split(':').at(-1)
  const origin = 'http://127.0.0.1:' + port
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) { try { ready = (await fetch(origin + '/healthz')).ok } catch { /* startup */ } if (!ready) await delay(250) }
  assert.ok(ready, 'Built public image must become healthy')
  let pricesReady = false
  for (let i = 0; i < 20 && !pricesReady; i++) { try { pricesReady = (await (await fetch(origin + '/hetzner')).text()).includes('CX-HTTP-fixture') } catch { /* fixture API startup */ } if (!pricesReady) await delay(250) }
  assert.ok(pricesReady, 'Fixture API must be reachable through actual SSI before assertions')
  for (const uri of ['/', '/hetzner']) {
    const normal = await fetch(origin + uri, { headers: { cookie: 'fixture-never-forward', authorization: 'Bearer fixture-never-forward' } })
    assert.equal(normal.status, 200); assert.ok(!normal.headers.get('x-robots-tag')?.includes('noindex'))
    const html = await normal.text(), bot = await (await fetch(origin + uri, { headers: { 'user-agent': 'Googlebot' } })).text()
    assert.equal(bot, html, 'Same complete content without JavaScript for ordinary and bot user agents')
    assert.equal((html.match(/<h1\b/g) || []).length, 1)
    if (uri === '/') assert.ok(html.includes('<p class="hero-tagline">با پرداخت ریالی و امکان خرید به صورت ساعتی</p>'))
    assert.ok(html.includes(`rel="canonical" href="https://parserver.ir${uri}"`))
    assert.ok(!/<meta name="robots" content="noindex/.test(html))
    assert.ok(html.includes('CX-HTTP-fixture') && html.includes('۱۲٬۳۴۵ تومان'))
    assert.ok(html.includes('<th scope="col">لوکیشن</th>'))
    assert.ok(html.includes('<summary aria-label="فنلاند"><img src="/flags/fi.svg"'))
    assert.ok(html.includes('<bdi>Helsinki، hel1</bdi>'))
    assert.ok(html.includes('offer=fixture-plan&amp;period=monthly&amp;location=hel1'))
    assert.ok(html.includes('۶۷۸٬۹۰۰ تومان'))
    assert.ok(!html.includes('انتخاب ساعتی') && !html.includes('انتخاب ماهانه'))
    assert.ok(html.includes('۲۱٫۹۹۰۲۳۲۵۵۵۵۲ TB') && html.includes('۳۳٬۳۴۵ تومان'))
    assert.ok(html.includes('og:image') && html.includes('/parserver-share.png'))
    assert.ok(!html.includes('<!--#'), 'SSI directives must be resolved, not exposed')
    assert.ok(html.includes('application/ld+json'))
    const tracked = await (await fetch(origin + uri + '?utm_source=fixture')).text()
    assert.ok(tracked.includes(`rel="canonical" href="https://parserver.ir${uri}"`))
  }
  const redirect = await fetch(origin + '/hetzner/?period=hourly&x=one%20two', { redirect: 'manual' })
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), 'https://parserver.ir/hetzner?period=hourly&x=one%20two')
  const http = await fetch(origin + '/hetzner?x=one%20two', { headers: { 'x-forwarded-proto': 'http' }, redirect: 'manual' })
  assert.equal(http.status, 308); assert.equal(http.headers.get('location'), 'https://parserver.ir/hetzner?x=one%20two')
  for (const uri of ['/dashboard', '/tickets', '/login', '/register', '/terms', '/privacy', '/servers/create?offer=fixture-plan&period=monthly', '/servers/fixture-id', '/admin/settings/sms', '/admin/settings/hetzner-margin', '/admin/settings/admin-roles', '/auth/callback']) {
    const response = await fetch(origin + uri)
    assert.equal(response.status, 200, uri); assert.ok(response.headers.get('x-robots-tag')?.includes('noindex'), uri)
    assert.ok((await response.text()).includes('content="noindex,follow"'), uri)
  }
  const sheet = await fetch(origin + '/kalameh/home.css')
  const css = await sheet.text()
  assert.equal(sheet.status, 200)
  assert.match(sheet.headers.get('content-type') ?? '', /^text\/css\b/)
  const font = await fetch(origin + '/kalameh/kalameh-bold.woff2')
  if (process.env.PUBLIC_SMOKE_LICENSED === '1') {
    assert.equal(font.status, 200)
    assert.match(font.headers.get('content-type') ?? '', /^font\/woff2\b/)
    const bytes = Buffer.from(await font.arrayBuffer())
    assert.equal(bytes.subarray(0, 4).toString(), 'wOF2')
    const folder = '/kalameh/' + createHash('sha256').update(bytes).digest('hex')
    assert.match(css, /@font-face[\s\S]*font-weight: 700;[\s\S]*font-display: swap;/)
    assert.ok(css.includes(`${folder}/kalameh-bold.woff2`))
    const versionedCss = await fetch(origin + folder + '/home.css')
    assert.equal(versionedCss.status, 200)
    assert.equal(await versionedCss.text(), css)
    const versionedFont = await fetch(origin + folder + '/kalameh-bold.woff2')
    assert.equal(versionedFont.status, 200)
    assert.deepEqual(Buffer.from(await versionedFont.arrayBuffer()), bytes)
    const home = await (await fetch(origin + '/')).text()
    assert.ok(home.includes(`rel="preload" href="${folder}/kalameh-bold.woff2"`))
    assert.ok(home.includes(`href="${folder}/home.css"`))
    assert.ok(!(await (await fetch(origin + '/hetzner')).text()).includes('/kalameh/'))
  } else {
    assert.doesNotMatch(css, /@font-face/)
    assert.equal(font.status, 404)
  }
  for (const uri of ['/does-not-exist-seo-check-2026', '/hetzner/fake', '/Dashboard', '/admin/fake', '/login/fake', '/assets/missing.js', '/missing.ico', '/home.html', '/hetzner.html', '/.vite/manifest.json']) {
    const response = await fetch(origin + uri)
    assert.equal(response.status, 404, uri); assert.ok((await response.text()).includes('این صفحه پیدا نشد'), uri)
  }
  const ico = await fetch(origin + '/favicon.ico'), png = await fetch(origin + '/parserver-share.png')
  assert.ok(ico.headers.get('content-type')?.includes('image/')); assert.equal(ico.status, 200)
  assert.deepEqual([...new Uint8Array(await ico.arrayBuffer()).slice(0, 4)], [0, 0, 1, 0])
  assert.equal(png.headers.get('content-type'), 'image/png'); assert.equal(png.status, 200)
  const bytes = Buffer.from(await png.arrayBuffer()); assert.equal(bytes.readUInt32BE(16), 1200); assert.equal(bytes.readUInt32BE(20), 630)
  const sitemap = await (await fetch(origin + '/sitemap.xml')).text()
  assert.ok(sitemap.includes('https://parserver.ir/hetzner')); assert.ok(!sitemap.includes('/dashboard'))
  assert.ok((await (await fetch(origin + '/robots.txt')).text()).includes('Sitemap: https://parserver.ir/sitemap.xml'))
  docker(['stop', id + '-api'])
  const outage = await (await fetch(origin + '/hetzner')).text()
  assert.ok(outage.includes('دریافت تعرفهٔ هتزنر موقتاً ممکن نیست.'), 'Backend outage must render the readable SSI stub')
  assert.ok(!outage.includes('CX-HTTP-fixture'))

  // Validate the host-ingress template too, with an explicitly synthetic cert.
  // No source or production certificate/config is replaced.
  const ingress = (await readFile('deploy/ingress/parserver.ir.conf', 'utf8')).replaceAll('/etc/letsencrypt/live/parserver.ir/fullchain.pem', '/fixture/test.crt').replaceAll('/etc/letsencrypt/live/parserver.ir/privkey.pem', '/fixture/test.key')
  await writeFile(path.join(tmp, 'host.conf'), ingress)
  const cert = spawnSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1', '-subj', '/CN=fixture.invalid', '-keyout', path.join(tmp, 'test.key'), '-out', path.join(tmp, 'test.crt')], { encoding: 'utf8', windowsHide: true })
  assert.equal(cert.status, 0, 'OpenSSL fixture certificate generation')
  docker(['run', '--rm', '--network', 'none', '--mount', `type=bind,src=${tmp},dst=/fixture,readonly`, '--mount', `type=bind,src=${path.join(tmp, 'host.conf')},dst=/etc/nginx/conf.d/default.conf,readonly`, 'nginx:1.27-alpine', 'nginx', '-t'])
  console.log('Public SEO HTTP smoke passed: real status codes, SSR prices, canonical/robots, UA parity, assets, auth deep links and SSI outage fallback. No browser or production mutation.')
} finally {
  for (const suffix of ['-web', '-api']) {
    const owner = docker(['inspect', '--format', '{{index .Config.Labels "parserver.seo-test"}}', id + suffix], true)
    if (owner === id) docker(['rm', '-f', id + suffix], true)
  }
  const owner = docker(['network', 'inspect', '--format', '{{index .Labels "parserver.seo-test"}}', id], true)
  if (owner === id) docker(['network', 'rm', id], true)
  const resolved = path.resolve(tmp)
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('public-seo-'))
  await rm(resolved, { recursive: true, force: true })
}
