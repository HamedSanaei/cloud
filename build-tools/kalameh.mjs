import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const directory = 'dist/kalameh'
const filename = 'kalameh-bold.woff2'

export function inspectWoff2(bytes) {
  if (bytes.length < 1024 || bytes.length > 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'wOF2'
    || bytes.readUInt32BE(8) !== bytes.length || bytes.readUInt16BE(12) === 0 || bytes.readUInt16BE(14) !== 0
    || bytes.readUInt32BE(20) === 0 || bytes.readUInt32BE(20) > bytes.length - 48) {
    throw new Error('Expected a valid Kalameh Web Bold WOFF2 file')
  }
  return createHash('sha256').update(bytes).digest('hex')
}

export async function writeKalameh() {
  const source = process.env.KALAMEH_FONT_FILE
  if (!source) {
    if (process.env.KALAMEH_FONT_REQUIRED === '1') throw new Error('This release requires KALAMEH_FONT_FILE')
    return null
  }
  const bytes = await readFile(source)
  const version = inspectWoff2(bytes)
  if (process.env.VITE_KALAMEH_VERSION && process.env.VITE_KALAMEH_VERSION !== version) throw new Error('Kalameh version does not match the supplied font')
  const root = `/kalameh/${version}`
  const url = `${root}/${filename}`
  const css = `@font-face {
  font-family: Kalameh;
  src: url('${url}') format('woff2');
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  unicode-range: U+0600-065F, U+066A-06EF, U+06FA-06FF, U+0750-077F, U+08A0-08FF;
}
`
  await mkdir(`${directory}/${version}`, { recursive: true })
  await Promise.all([
    writeFile(`${directory}/${filename}`, bytes), writeFile(`${directory}/home.css`, css),
    writeFile(`${directory}/${version}/${filename}`, bytes), writeFile(`${directory}/${version}/home.css`, css),
  ])
  return { version, url }
}

async function verifyKalameh() {
  const bytes = await readFile(`${directory}/${filename}`)
  const version = inspectWoff2(bytes)
  if (process.env.VITE_KALAMEH_VERSION && process.env.VITE_KALAMEH_VERSION !== version) throw new Error('Packaged Kalameh does not match the release input')
  const url = `/kalameh/${version}/${filename}`
  const css = await readFile(`${directory}/home.css`, 'utf8')
  const versionedCss = await readFile(`${directory}/${version}/home.css`, 'utf8')
  const versionedFont = await readFile(`${directory}/${version}/${filename}`)
  if (!bytes.equals(versionedFont) || css !== versionedCss || !css.includes('@font-face') || !css.includes('font-family: Kalameh;')
    || !css.includes(`url('${url}')`) || !css.includes('font-weight: 700;') || !css.includes('font-display: swap;')) {
    throw new Error('Packaged Kalameh stylesheet or versioned files are invalid')
  }
  const [homeHead] = (await readFile('dist/home.html', 'utf8')).split('</head>')
  const relatedPath = process.env.VITE_KALAMEH_VERSION ? `/kalameh/${version}/home.css` : '/kalameh/home.css'
  if (!homeHead.includes(`rel="preload" href="${url}" as="font" type="font/woff2" crossorigin`) || !homeHead.includes(`href="${relatedPath}"`)) {
    throw new Error('The homepage is missing the matching Kalameh stylesheet or preload')
  }
  for (const page of ['hetzner', 'index']) {
    if ((await readFile(`dist/${page}.html`, 'utf8')).includes('/kalameh/')) throw new Error('Kalameh must stay scoped to the homepage')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await verifyKalameh()
