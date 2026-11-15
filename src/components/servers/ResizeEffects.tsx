import type { ResizePreview } from '../../lib/serverManagement'

export function resizeEffectsVerified(preview: ResizePreview) {
  return Number.isFinite(preview.currentDiskGb) && preview.currentDiskGb > 0
    && Number.isFinite(preview.resultingDiskGb) && preview.resultingDiskGb >= preview.currentDiskGb
    && preview.powerAfterResize === 'may_start'
}
/** Reuse the exact server-validated quote in preview and final confirmation. */
export function ResizeEffects({ preview }: { preview: ResizePreview }) {
  return <div className="server-resize-effects">
    <dl className="server-facts"><div><dt>پلن مقصد</dt><dd><bdi>{preview.serverType}</bdi></dd></div>
      <div><dt>ظرفیت فعلی دیسک</dt><dd><bdi dir="ltr">{preview.currentDiskGb} GB</bdi></dd></div>
      <div><dt>ظرفیت دیسک پس از تغییر</dt><dd><bdi dir="ltr">{preview.resultingDiskGb} GB</bdi></dd></div></dl>
    <p>{preview.upgradeDisk ? 'افزایش ظرفیت دیسک دائمی است؛ بازگشت به دیسک کوچک‌تر ممکن نیست.' : 'دیسک فعلی حفظ می‌شود؛ ظرفیت اسمی کارت پلن روی دیسک اعمال نمی‌شود.'}</p>
    <p className="server-notice">سرور ممکن است پس از تغییر پلن روشن شود. خاموش بودن پس از عملیات تضمین نمی‌شود؛ وضعیت برق را در نتیجهٔ عملیات بررسی کنید.</p>
  </div>
}
