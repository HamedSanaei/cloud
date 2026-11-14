import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { LandingPage } from './pages/LandingPage'
import { fallbackTariffs } from './components/HomeTariffs'

export function renderHomepage() {
  const fragment = '<!--# block name="tariff_fallback" -->' + fallbackTariffs + '<!--# endblock -->' +
    '<!--# include virtual="/_home-tariffs" stub="tariff_fallback" -->'
  return renderToString(<StaticRouter location="/"><AuthProvider><LandingPage initialTariffs={fragment} /></AuthProvider></StaticRouter>)
}
