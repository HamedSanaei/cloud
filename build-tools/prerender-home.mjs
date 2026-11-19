import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { writeKalameh } from './kalameh.mjs'

const font = await writeKalameh()
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const escape = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
try {
  const { renderHomepage, publicPages, PUBLIC_ORIGIN, shareImage } = await server.ssrLoadModule('/src/home-entry.tsx')
  const shell = await readFile('dist/index.html', 'utf8')
  if (!shell.includes('<div id="root"></div>')) throw new Error('Public mount is missing from Vite shell')
  const clean = shell.replace(/<title>[^<]*<\/title>/, '').replace(/<meta name="(?:description|robots)"[^>]*>/g, '')
  for (const [path, { title, description }] of Object.entries(publicPages)) {
    const markup = renderHomepage(path)
    // React mounts the client app into #root and replaces all of its prerendered children.
    // Keep the stylesheet in the document head so the browser retains it across that mount.
    const fontStylesheet = markup.match(/<link rel="stylesheet" href="\/kalameh\/(?:[a-f0-9]{64}\/)?home\.css" data-precedence="default"\/>/)?.[0] ?? ''
    const canonical = PUBLIC_ORIGIN + path
    const schema = path === '/' ? [
      { '@context': 'https://schema.org', '@type': 'WebSite', name: 'پارس سرور', url: canonical, inLanguage: 'fa' },
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'پارس سرور', url: PUBLIC_ORIGIN + '/', logo: PUBLIC_ORIGIN + '/favicon.png' },
    ] : [{ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'خانه', item: PUBLIC_ORIGIN + '/' },
      { '@type': 'ListItem', position: 2, name: 'سرور هتزنر', item: canonical },
    ] }]
    const fontPreload = path === '/' && font
      ? `<link rel="preload" href="${font.url}" as="font" type="font/woff2" crossorigin>`
      : ''
    const metadata = `${fontPreload}${fontStylesheet}<title>${escape(title)}</title>
    <meta name="description" content="${escape(description)}">
    <link rel="canonical" href="${canonical}">
    <meta property="og:type" content="website"><meta property="og:locale" content="fa_IR">
    <meta property="og:site_name" content="پارس سرور"><meta property="og:title" content="${escape(title)}">
    <meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${canonical}">
    <meta property="og:image" content="${shareImage}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:type" content="image/png"><meta property="og:image:alt" content="پارس سرور؛ مقایسهٔ منابع و قیمت سرور ابری">
    <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escape(title)}"><meta name="twitter:description" content="${escape(description)}"><meta name="twitter:image" content="${shareImage}">
    ${schema.map(value => '<script type="application/ld+json">' + JSON.stringify(value).replaceAll('<', '\\u003c') + '</script>').join('')}`
    await writeFile('dist/' + (path === '/' ? 'home' : 'hetzner') + '.html', clean.replace('</head>', metadata + '</head>').replace('<div id="root"></div>', () => `<div id="root">${markup.replace(fontStylesheet, '')}</div>`))
  }
} finally { await server.close() }
