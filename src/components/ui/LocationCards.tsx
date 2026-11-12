import { Globe } from 'lucide-react'
import type { StorefrontDatacenter } from '../../lib/types'

const countryNames = new Intl.DisplayNames(['fa'], { type: 'region' })
const fallback: Record<string, { city: string; country: string }> = {
  fsn1: { city: 'فالکنشتاین', country: 'DE' }, nbg1: { city: 'نورنبرگ', country: 'DE' },
  hel1: { city: 'هلسینکی', country: 'FI' }, ash: { city: 'اشبرن', country: 'US' },
  hil: { city: 'هیلزبورو', country: 'US' }, sin: { city: 'سنگاپور', country: 'SG' },
}
const cities: Record<string, string> = { Falkenstein: 'فالکنشتاین', Nuremberg: 'نورنبرگ', Helsinki: 'هلسینکی', Ashburn: 'اشبرن', Hillsboro: 'هیلزبورو', Singapore: 'سنگاپور' }
export function LocationCards({ locations, selected, onSelect }: {
  locations: StorefrontDatacenter['locations']; selected: string; onSelect: (code: string) => void
}) {
  return <fieldset className="location-picker"><legend>موقعیت سرور</legend><div className="location-grid">{locations.map(location => {
    const country = (location.country || fallback[location.code]?.country || '').toUpperCase()
    const countryName = /^[A-Z]{2}$/.test(country) ? countryNames.of(country) : location.country
    const city = cities[location.city ?? ''] || location.city || fallback[location.code]?.city || location.code
    return <button key={location.code} type="button" aria-pressed={selected === location.code}
      className={`choice-card location-card ${selected === location.code ? 'choice-card--selected' : ''}`} onClick={() => onSelect(location.code)}>
      {['DE', 'FI', 'US', 'SG'].includes(country) ? <img src={`/flags/${country.toLowerCase()}.svg`} width="48" height="32" alt={`پرچم ${countryName}`} /> : <Globe size={32} aria-hidden="true" />}
      <strong>{city}</strong><span>{countryName || 'موقعیت دیتاسنتر'}</span><small dir="ltr">{location.code}</small>
    </button>
  })}</div></fieldset>
}
