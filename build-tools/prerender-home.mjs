import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
try {
  const { renderHomepage } = await server.ssrLoadModule('/src/home-entry.tsx')
  const shell = await readFile('dist/index.html', 'utf8')
  const title = 'خرید سرور هتزنر و تعرفه سرور ایران | پارس سرور'
  const description = 'پلن‌های ساعتی و ماهانهٔ قابل سفارش هتزنر را با مشخصات و تعرفهٔ تومانی مقایسه کنید و وضعیت عرضه و نرخ ماهانهٔ منابع سرور ایران را ببینید.'
  const canonical = 'https://parserver.ir/'
  const metadata = `<title>${title}</title>
    <meta name="description" content="${description}">
    <link rel="canonical" href="${canonical}">
    <meta property="og:type" content="website">
    <meta property="og:locale" content="fa_IR">
    <meta property="og:site_name" content="پارس سرور">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'پارس سرور', url: canonical, inLanguage: 'fa' })}</script>`
  if (!shell.includes('<div id="root"></div>')) throw new Error('Homepage mount is missing from Vite shell')
  await writeFile('dist/home.html', shell.replace(/<title>[^<]*<\/title>/, () => metadata)
    .replace(/<meta name="description"[^>]*>/, '')
    .replace('<div id="root"></div>', () => `<div id="root">${renderHomepage()}</div>`))
} finally { await server.close() }
