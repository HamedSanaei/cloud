import { renderHomeTariffs } from '../backend/src/contracts/home-tariffs'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { PublicPage } from './public/PublicPage'
import type { PublicPath } from './public/metadata'
export { publicPages, PUBLIC_ORIGIN, shareImage } from './public/metadata'
import { fallbackTariffs } from './components/HomeTariffs'

export function renderHomepage(path: PublicPath = '/') {
  const fallback = path === '/hetzner' ? renderHomeTariffs(null, null, undefined, 'hetzner') : fallbackTariffs
  const include = path === '/hetzner' ? '/_hetzner-tariffs' : '/_home-tariffs'
  const fragment = '<!--# block name="tariff_fallback" -->' + fallback + '<!--# endblock -->' +
    `<!--# include virtual="${include}" stub="tariff_fallback" -->`
  return renderToString(<StaticRouter location={path}><AuthProvider><PublicPage path={path} initialTariffs={fragment} /></AuthProvider></StaticRouter>)
}
