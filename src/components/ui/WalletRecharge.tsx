import { useRef, useState } from 'react'
import { Button } from './Button'
import { Input, Select } from './FormControls'
import { Modal } from './Modal'
import { getIntegrationStatus, platformGet, platformPost } from '../../lib/platformClient'
import { useApiQuery } from '../../hooks/useApiQuery'

export function WalletRecharge() {
  const status = useApiQuery(getIntegrationStatus)
  const [open, setOpen] = useState(false)
  const [gateways, setGateways] = useState<string[]>([])
  const [gateway, setGateway] = useState('')
  const [amount, setAmount] = useState('')
  const [payment, setPayment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const key = useRef(crypto.randomUUID())
  const lock = useRef(false)
  const perform = async (work: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : 'درخواست تکمیل نشد') }
    finally { lock.current = false; setBusy(false) }
  }
  if (!status.data?.enabled) return null
  return <>
    <Button variant="success" disabled={busy || !status.data.linked} onClick={() => {
      setOpen(true)
      void perform(async () => {
        const wallet = await platformGet<{ balance: { currency: string } }>('/wallet')
        if (wallet.balance.currency !== 'IRT') throw new Error('شارژ تومانی برای واحد فعلی کیف پول مجاز نیست')
        const list = await platformGet<string[]>('/recharge/gateways'); setGateways(list); setGateway(list[0] ?? '')
      })
    }}>شارژ کیف پول</Button>
    <Modal open={open} title="شارژ کیف پول مشترک" onClose={() => { if (!busy) setOpen(false) }}>
      <form className="form-stack" onSubmit={e => { e.preventDefault(); void perform(async () => {
        const value = Number(amount)
        if (!Number.isSafeInteger(value) || value <= 0 || !gateway) throw new Error('مبلغ صحیح مثبت و درگاه معتبر انتخاب کنید')
        const response = await platformPost<{ paymentUrl: string }>('/recharge', { amountMinor: value, gateway }, key.current)
        const url = new URL(response.paymentUrl)
        if (url.protocol !== 'https:') throw new Error('لینک امن پرداخت در دسترس نیست؛ وضعیت درخواست را بررسی کنید')
        setPayment(url.toString())
      }) }}>
        <p>مبلغ به تومان است. تأیید درگاه، موجودی همین حساب را در سایت و ربات به‌روز می‌کند.</p>
        <Input label="مبلغ (تومان)" inputMode="numeric" required disabled={busy} value={amount} onChange={e => { setAmount(e.target.value); setPayment(''); key.current = crypto.randomUUID() }} />
        <Select label="درگاه پرداخت" required disabled={busy} value={gateway} onChange={e => { setGateway(e.target.value); setPayment(''); key.current = crypto.randomUUID() }}><option value="">انتخاب کنید</option>{gateways.map(item => <option key={item}>{item}</option>)}</Select>
        {!busy && !gateways.length && <p role="status">درگاه سازگار با کیف پول در دسترس نیست.</p>}
        {error && <p role="alert" className="platform-error">{error}</p>}
        <Button type="submit" disabled={busy || !gateway || !amount || !!payment}>دریافت لینک پرداخت امن</Button>
        {payment && <a className="button button--primary button--md" href={payment} target="_blank" rel="noreferrer">ادامه پرداخت در درگاه</a>}
      </form>
    </Modal>
  </>
}
