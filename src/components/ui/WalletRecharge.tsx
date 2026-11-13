import { useRef, useState } from 'react'
import { Button } from './Button'
import { Input, Select } from './FormControls'
import { Modal } from './Modal'
import { getIntegrationStatus, platformGet, platformPost } from '../../lib/platformClient'
import { useApiQuery } from '../../hooks/useApiQuery'
import { apiGet, apiPost } from '../../lib/apiClient'
import { Link } from 'react-router-dom'
import { firstPartyTabapayHandoff } from '../../lib/paymentHandoff'
import type { Wallet } from '../../lib/types'

export function WalletRecharge() {
  const status = useApiQuery(getIntegrationStatus)
  const [open, setOpen] = useState(false)
  const [gateways, setGateways] = useState<string[]>([])
  const [gateway, setGateway] = useState('')
  const [amount, setAmount] = useState('')
  const [payment, setPayment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [walletId, setWalletId] = useState('')
  const [attemptId, setAttemptId] = useState('')
  const [attemptStatus, setAttemptStatus] = useState('')
  const key = useRef(crypto.randomUUID())
  const lock = useRef(false)
  const perform = async (work: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : 'درخواست تکمیل نشد') }
    finally { lock.current = false; setBusy(false) }
  }
  const shared = status.data?.enabled === true
  return <>
    <Button variant="success" disabled={busy || status.loading || !!status.error || (shared && !status.data?.linked)} onClick={() => {
      setOpen(true)
      void perform(async () => {
        if (shared) {
          const wallet = await platformGet<{ balance: { currency: string } }>('/wallet')
          if (wallet.balance.currency !== 'IRT') throw new Error('شارژ تومانی برای واحد فعلی کیف پول مجاز نیست')
          const list = await platformGet<string[]>('/recharge/gateways'); setGateways(list); setGateway(list[0] ?? '')
        } else {
          const { data } = await apiGet<{ data: { enabled: boolean; gateways: string[]; wallets: Wallet[] } }>('/wallets/recharge/options')
          if (!data.enabled) throw new Error('درگاه پرداخت هنوز پیکربندی نشده است؛ با پشتیبانی تماس بگیرید.')
          setWallets(data.wallets)
          if (!attemptId) setWalletId(data.wallets.find(w => w.isDefault)?.id || data.wallets[0]?.id || '')
          setGateways(data.gateways); setGateway(data.gateways[0] || '')
        }
      })
    }}>شارژ کیف پول</Button>
    <Modal open={open} title="شارژ کیف پول" onClose={() => { if (!busy) setOpen(false) }}>
      <form className="form-stack" onSubmit={e => { e.preventDefault(); void perform(async () => {
        const value = Number(amount)
        if (!Number.isSafeInteger(value) || value <= 0 || !gateway) throw new Error('مبلغ صحیح مثبت و درگاه معتبر انتخاب کنید')
        if (gateway === 'tabapay' && (value < 10_000 || value > 50_000_000)) {
          throw new Error('مبلغ شارژ با تاباپی باید بین ۱۰٬۰۰۰ تا ۵۰٬۰۰۰٬۰۰۰ تومان باشد')
        }
        if (!shared && !walletId) throw new Error('کیف پول پرداخت را انتخاب کنید.')
        const response = shared
          ? await platformPost<{ paymentUrl: string; id?: string; status?: string }>('/recharge', { amountMinor: value, gateway }, key.current)
          : (await apiPost<{ data: { paymentUrl: string | null; id: string; status: string } }>('/wallets/recharges', { walletId, amountToman: value }, { headers: { 'idempotency-key': key.current }, timeoutMs: 22000 })).data
        setAttemptId(response.id || '')
        setAttemptStatus(response.status || '')
        if (!response.paymentUrl) throw new Error('لینک پرداخت آماده نشد؛ نتیجه همین درخواست را پیگیری کنید.')
        const url = new URL(response.paymentUrl)
        if (url.protocol !== 'https:') throw new Error('لینک امن پرداخت در دسترس نیست؛ وضعیت درخواست را بررسی کنید')
        setPayment(shared ? url.toString() : firstPartyTabapayHandoff(url.toString()))
      }) }}>
        <p>مبلغ به تومان است. موجودی پس از تأیید پرداخت توسط درگاه افزایش می‌یابد.</p>
        <div className="payment-vpn-notice" role="note"><strong>پیش از ورود به درگاه، VPN یا فیلترشکن را خاموش کنید.</strong><p>روشن بودن آن ممکن است باعث اختلال یا رد پرداخت شود.</p></div>
        {!shared ? <Select label="کیف پول مقصد" required disabled={busy || !!attemptId} value={walletId} onChange={e => { setWalletId(e.target.value); key.current = crypto.randomUUID() }}>{wallets.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</Select> : null}
        <Input label="مبلغ (تومان)" inputMode="numeric" required disabled={busy || !!attemptId} value={amount} onChange={e => { setAmount(e.target.value); setPayment(''); key.current = crypto.randomUUID() }} />
        <Select label="درگاه پرداخت" required disabled={busy || !!attemptId} value={gateway} onChange={e => { setGateway(e.target.value); setPayment(''); key.current = crypto.randomUUID() }}><option value="">انتخاب کنید</option>{gateways.map(item => <option key={item} value={item}>{item === 'tabapay' ? 'تاباپی' : item}</option>)}</Select>
        {!busy && !gateways.length && <p role="status">درگاه سازگار با کیف پول در دسترس نیست.</p>}
        {error && <p role="alert" className="platform-error">{error}</p>}
        <Button type="submit" disabled={busy || !gateway || !amount || !!payment || !!attemptId}>دریافت لینک پرداخت امن</Button>
        {payment && <a className="button button--primary button--md" href={payment} target={shared ? "_blank" : undefined} rel={shared ? "noopener" : undefined} referrerPolicy="origin">ادامه پرداخت در درگاه</a>}
        {attemptId && <Link className="button button--secondary button--md" to={`/wallet?payment=${attemptId}`} onClick={() => setOpen(false)}>پیگیری نتیجه پرداخت</Link>}
        {attemptId && (payment || attemptStatus === 'failed') && <Button variant="secondary" onClick={() => { setAttemptId(''); setAttemptStatus(''); setPayment(''); setError(''); key.current = crypto.randomUUID() }}>درخواست شارژ جدید</Button>}
      </form>
    </Modal>
  </>
}
