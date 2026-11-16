/** Registered shortened patterns; dynamic approval confirmed by the owner 2026-11-16.
 * This is operator-attested approval, not an automated ParsGreen status query.
 * Never add an unverified generic fallback or silently truncate substitutions.
 */
export type ParsGreenApproval = 'approved-pattern' | 'approved-sample' | 'rejected' | 'unknown'
export interface ParsGreenTemplate {
  event: string; name: string; group: string; approval: ParsGreenApproval
  pattern: string; sample: string; variables: readonly string[]; ready: boolean
}
export const PARSGREEN_TEMPLATES = {
  ticketClosed: { name: "بسته‌شدن تیکت", group: "تیکت‌ها", event: "ticket.closed", approval: "approved-pattern", ready: true, variables: ["ticketNumber"], pattern: "پارس سرور: تیکت %% بسته شد. parserver.ir", sample: "پارس سرور: تیکت 1052 بسته شد. parserver.ir" },
  ticketReplied: { name: "پاسخ تیکت", group: "تیکت‌ها", event: "ticket.replied", approval: "approved-pattern", ready: true, variables: ["ticketNumber"], pattern: "پارس سرور: تیکت %% پاسخ داده شد. parserver.ir", sample: "پارس سرور: تیکت 1052 پاسخ داده شد. parserver.ir" },
  ticketCreated: { name: "ثبت تیکت", group: "تیکت‌ها", event: "ticket.created", approval: "approved-pattern", ready: true, variables: ["ticketNumber"], pattern: "پارس سرور: تیکت %% ثبت شد. parserver.ir", sample: "پارس سرور: تیکت 1052 ثبت شد. parserver.ir" },
  incidentResolved: { name: "رفع اختلال", group: "سرویس‌ها", event: "service.incident_resolved", approval: "approved-pattern", ready: true, variables: ["serviceName"], pattern: "پارس سرور: اختلال %% رفع شد. parserver.ir", sample: "پارس سرور: اختلال cloud-01 رفع شد. parserver.ir" },
  incidentDetected: { name: "اعلام اختلال", group: "سرویس‌ها", event: "service.incident_detected", approval: "approved-pattern", ready: true, variables: ["serviceName"], pattern: "پارس سرور: اختلال %% در حال بررسی است. parserver.ir", sample: "پارس سرور: اختلال cloud-01 در حال بررسی است. parserver.ir" },
  serviceSuspended: { name: "تعلیق سرویس", group: "سرویس‌ها", event: "service.suspended", approval: "approved-pattern", ready: true, variables: ["serviceName"], pattern: "پارس سرور: سرویس %% تعلیق شد. parserver.ir", sample: "پارس سرور: سرویس cloud-01 تعلیق شد. parserver.ir" },
  serverStoppedNoCredit: { name: "خاموشی کمبود اعتبار", group: "سرویس‌ها", event: "server.stopped_no_credit", approval: "approved-pattern", ready: true, variables: ["serviceName"], pattern: "پارس سرور: %% کمبود اعتبار دارد و خاموش شد؛ شارژ کنید.", sample: "پارس سرور: cloud-01 کمبود اعتبار دارد و خاموش شد؛ شارژ کنید." },
  walletLowBalance: { name: "اعتبار کم", group: "کیف پول", event: "wallet.low_balance", approval: "approved-pattern", ready: true, variables: ["serviceName"], pattern: "پارس سرور: اعتبار %% کم است؛ کیف پول را شارژ کنید.", sample: "پارس سرور: اعتبار cloud-01 کم است؛ کیف پول را شارژ کنید." },
  serviceExpiring: { name: "سررسید سرویس", group: "سرویس‌ها", event: "service.expiring", approval: "approved-pattern", ready: true, variables: ["serviceName", "endDate"], pattern: "پارس سرور: %% در %% منقضی می‌شود.", sample: "پارس سرور: cloud-01 در 1405/08/25 منقضی می‌شود." },
  serviceRenewed: { name: "تمدید سرویس", group: "سرویس‌ها", event: "service.renewed", approval: "approved-pattern", ready: true, variables: ["serviceName", "endDate"], pattern: "پارس سرور: %% تمدید شد. پایان: %%.", sample: "پارس سرور: cloud-01 تمدید شد. پایان: 1405/08/25." },
  provisioningDelayed: { name: "تاخیر ساخت", group: "سرویس‌ها", event: "server.provisioning_delayed", approval: "approved-pattern", ready: true, variables: ["orderNumber"], pattern: "پارس سرور: ساخت سفارش %% با تاخیر روبه‌رو شد.", sample: "پارس سرور: ساخت سفارش ord-202611-000123 با تاخیر روبه‌رو شد." },
  serverActivated: { name: "فعال‌شدن سرور", group: "سرویس‌ها", event: "server.activated", approval: "approved-pattern", ready: true, variables: ["serviceName", "serverIp"], pattern: "پارس سرور: %% فعال شد. IP: %%", sample: "پارس سرور: cloud-01 فعال شد. IP: 192.0.2.20" },
  orderPaymentFailed: { name: "شکست قطعی پرداخت", group: "سفارش‌ها", event: "order.payment_failed", approval: "approved-pattern", ready: true, variables: ["orderNumber"], pattern: "پارس سرور: پرداخت سفارش %% ناموفق بود.", sample: "پارس سرور: پرداخت سفارش ord-202611-000123 ناموفق بود." },
  invoiceIssued: { name: "صدور فاکتور", group: "سفارش‌ها", event: "invoice.issued", approval: "approved-pattern", ready: true, variables: ["invoiceNumber", "amount"], pattern: "پارس سرور: فاکتور %%، %% تومان صادر شد.", sample: "پارس سرور: فاکتور inv-202611-000123، 1000000 تومان صادر شد." },
  orderRefunded: { name: "بازپرداخت سفارش", group: "کیف پول", event: "order.refunded", approval: "approved-pattern", ready: true, variables: ["amount", "orderNumber"], pattern: "پارس سرور: %% تومان سفارش %% بازگشت.", sample: "پارس سرور: 1000000 تومان سفارش ord-202611-000123 بازگشت." },
  walletCredited: { name: "واریز به کیف پول", group: "کیف پول", event: "wallet.credited", approval: "approved-pattern", ready: true, variables: ["amount", "balance"], pattern: "پارس سرور: %% تومان واریز شد. موجودی: %%", sample: "پارس سرور: 1000000 تومان واریز شد. موجودی: 1250000" },
  orderPaid: { name: "پرداخت سفارش", group: "سفارش‌ها", event: "order.paid", approval: "approved-pattern", ready: true, variables: ["orderNumber", "amount"], pattern: "پارس سرور: سفارش %% پرداخت شد؛ %% تومان.", sample: "پارس سرور: سفارش ord-202611-000123 پرداخت شد؛ 1000000 تومان." },
  orderCreated: { name: "ثبت سفارش", group: "سفارش‌ها", event: "order.created", approval: "approved-pattern", ready: true, variables: ["orderNumber"], pattern: "پارس سرور: سفارش %% ثبت شد؛ منتظر پرداخت.", sample: "پارس سرور: سفارش ord-202611-000123 ثبت شد؛ منتظر پرداخت." },
  newLogin: { name: "ورود جدید", group: "امنیت حساب", event: "account.new_login", approval: "approved-pattern", ready: true, variables: ["ip"], pattern: "پارس سرور: ورود از %%. اگر شما نبودید، رمز را عوض کنید.", sample: "پارس سرور: ورود از 192.0.2.15. اگر شما نبودید، رمز را عوض کنید." },
  passwordChanged: { name: "تغییر رمز", group: "امنیت حساب", event: "account.password_changed", approval: "approved-pattern", ready: true, variables: [], pattern: "پارس سرور: رمز تغییر کرد. اگر شما نبودید، به پشتیبانی خبر دهید.", sample: "پارس سرور: رمز تغییر کرد. اگر شما نبودید، به پشتیبانی خبر دهید." },
} as const satisfies Record<string, ParsGreenTemplate>
export type ParsGreenTemplateKey = keyof typeof PARSGREEN_TEMPLATES
export const PARSGREEN_AUTH_SAMPLES = {
  phoneVerification: { name: "تأیید شماره همراه", group: "احراز هویت", event: "account.phone_verification", approval: "approved-pattern", ready: true, variables: ["code", "code"], pattern: "پارس سرور کد تایید شماره همراه شما: %% @parserver.ir #%%", sample: "پارس سرور کد تایید شماره همراه شما: 479125 @parserver.ir #479125" },
  phoneLogin: { name: "ورود پیامکی", group: "احراز هویت", event: "account.phone_login", approval: "approved-pattern", ready: true, variables: ["code", "code"], pattern: "پارس سرور: کد ورود %%؛ محرمانه\n@parserver.ir #%%", sample: "پارس سرور: کد ورود 479125؛ محرمانه\n@parserver.ir #479125" },
  passwordRecovery: { name: "بازیابی رمز پیامکی", group: "احراز هویت", event: "account.password_recovery", approval: "approved-pattern", ready: true, variables: ["code", "code"], pattern: "پارس سرور کد بازیابی رمز عبور: %% @parserver.ir #%%", sample: "پارس سرور کد بازیابی رمز عبور: 479125 @parserver.ir #479125" },
  accountOperation: { name: "تأیید عملیات حساب", group: "احراز هویت", event: "account.operation_verification", approval: "approved-pattern", ready: true, variables: ["code", "code"], pattern: "پارس سرور کد تایید عملیات حساب کاربری: %% @parserver.ir #%%", sample: "پارس سرور کد تایید عملیات حساب کاربری: 479125 @parserver.ir #479125" },
} as const satisfies Record<string, ParsGreenTemplate>
export const SMS_CATALOG = { ...PARSGREEN_TEMPLATES, ...PARSGREEN_AUTH_SAMPLES }
export type SmsKey = keyof typeof SMS_CATALOG
export const smsKeys = Object.keys(SMS_CATALOG) as SmsKey[]
export function smsSegments(message: string) {
  return { units: message.length, segments: message.length === 0 ? 0 : message.length <= 70 ? 1 : Math.ceil(message.length / 67) }
}
export function renderSms(key: SmsKey, values: Record<string, string>): string {
  const template = SMS_CATALOG[key]
  let i = 0
  return template.pattern.replaceAll('%%', () => {
    const variable = template.variables[i++]!
    const value = values[variable]
    if (!value || (variable === 'code' && !/^\d{6}$/.test(value)) || /[\r\n]|%%/.test(value) || value.length > 256) throw new Error('Invalid SMS substitution')
    return value
  })
}
