import { useState } from 'react'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/FormControls'
import { formatFaDateTime } from '../lib/format'
import { actionLabels, type ServerOperation } from '../lib/serverManagement'
import { adminApi, type LegacyPowerEvidence } from './api'

export function LegacyPowerReview({ serverId, operation, onResolved }: { serverId: string; operation: ServerOperation; onResolved: () => void }) {
  const [evidence, setEvidence] = useState<LegacyPowerEvidence | null>(null)
  const [actionId, setActionId] = useState(''), [note, setNote] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const canResolve = /^[1-9][0-9]*$/.test(actionId) && Number.isSafeInteger(Number(actionId)) && !!note.trim()
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work() } catch (error) { setError(error instanceof Error ? error.message : 'بررسی عملیات ناموفق بود.') }
    finally { setBusy(false) }
  }

  return <div className="form-stack">
    <p>{actionLabels[operation.action]} · {formatFaDateTime(operation.createdAt)} · <bdi>{operation.id}</bdi></p>
    <p>شناسهٔ اقدام را با زمان درخواست و سابقهٔ پروژهٔ مالک تطبیق دهید. رفع قفل به رسید نهایی منطبق نیاز دارد.</p>
    <div><Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
      setEvidence(null)
      setEvidence(await adminApi.legacyPowerEvidence(serverId, operation.id))
    })}>خواندن وضعیت و سابقهٔ Hetzner</Button></div>
    {evidence && <div aria-live="polite">
      <p>وضعیت فعلی سرور در Hetzner: {evidence.state === 'active' ? 'روشن' : evidence.state === 'suspended' ? 'خاموش' : 'نامشخص'}</p>
      {evidence.candidates.length ? <ul>{evidence.candidates.map(action => <li key={action.id}>
        <bdi>{action.id} · {action.command}</bdi> · {formatFaDateTime(action.startedAt)} · {action.status === 'success' ? 'موفق' : action.status === 'error' ? 'ناموفق' : 'در حال اجرا'}
      </li>)}</ul> : <p>در سابقهٔ بررسی‌شده رسید منطبق پیدا نشد. تا دریافت رسید معتبر از Hetzner، قفل عملیات باقی می‌ماند.</p>}
    </div>}
    <form className="form-stack" onSubmit={event => {
      event.preventDefault()
      if (!busy && canResolve) void run(async () => { await adminApi.resolveLegacyPower(serverId, operation.id, Number(actionId), note.trim()); onResolved() })
    }}>
      <Input label="شناسهٔ اقدام Hetzner" dir="ltr" inputMode="numeric" value={actionId} onChange={event => setActionId(event.target.value)} required />
      <Input label="دلیل تطبیق رسید با درخواست" value={note} onChange={event => setNote(event.target.value)} maxLength={500} required />
      <div><Button type="submit" disabled={busy || !canResolve}>اعتبارسنجی و ثبت نتیجه</Button></div>
    </form>
    {error && <p role="alert">{error}</p>}
  </div>
}
