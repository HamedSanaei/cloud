import { formatTrafficTb, indicativeOverageNotice, tariffTime, type IndicativeTrafficTariff } from '../../../backend/src/contracts/home-tariffs'
import { formatToman } from '../../lib/format'

export function HetznerTraffic({ includedBytes, overage, className }: {
  includedBytes?: number | null; overage?: IndicativeTrafficTariff | null; className?: string
}) {
  return <div className={className}>
    <div>
      <div>ترافیک ماهانهٔ مشمول: <bdi>{formatTrafficTb(includedBytes ?? overage?.includedBytes)}</bdi></div>
      <div>قیمت هر ترابایت ترافیک مازاد: {overage ? <><bdi>{formatToman(overage.perTbRial / 10)}</bdi> <bdi>/ TB</bdi></> : 'نرخ معتبر در دسترس نیست'}</div>
      <small>{indicativeOverageNotice}{overage && <>
        {' تعرفهٔ کاتالوگ: '}<time dateTime={overage.observedAt}>{tariffTime.format(new Date(overage.observedAt))}</time>.
        {' نرخ ارز: '}<time dateTime={overage.fxAt}>{tariffTime.format(new Date(overage.fxAt))}</time>.
      </>}</small>
    </div>
  </div>
}
