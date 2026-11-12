/**
 * ParsGreen "WhiteText" messages copied from the operator's panel on 2026-11-12.
 * approval: approved means the specific displayed sample was marked "تایید".
 * Dynamic replacements MUST be approved by ParsGreen separately; this catalog
 * is not a provider template ID registry nor proof of blacklist/white-line delivery.
 * No credentials, sender identifiers or recipient data belong in this file.
 */
export type ParsGreenApproval = 'approved-sample' | 'rejected' | 'unknown'
export interface ParsGreenTemplate {
  event: string
  approval: ParsGreenApproval
  sample: string
  variables: readonly string[]
}

export const PARSGREEN_TEMPLATES = {
  ticketClosed: { event: 'ticket.closed', approval: 'approved-sample', variables: ['ticketNumber'], sample: 'پارس سرور: درخواست پشتیبانی شماره 1052 بسته شد. جزئیات در پنل کاربری قابل مشاهده است. parserver.ir' },
  ticketReplied: { event: 'ticket.replied', approval: 'rejected', variables: ['ticketNumber'], sample: 'پارس سرور: درخواست پشتیبانی شماره %% پاسخ داده شد. برای مشاهده پاسخ وارد پنل کاربری شوید. parserver.ir' },
  ticketCreated: { event: 'ticket.created', approval: 'approved-sample', variables: ['ticketNumber'], sample: 'پارس سرور: درخواست پشتیبانی شما با شماره 1052 ثبت شد و در انتظار بررسی است. parserver.ir' },
  incidentResolved: { event: 'service.incident_resolved', approval: 'approved-sample', variables: ['serviceName'], sample: 'پارس سرور: بررسی اختلال سرویس cloud-01 تکمیل شد و مشکل رفع شده است. لطفا وضعیت سرویس را بررسی کنید. parserver.ir' },
  incidentDetected: { event: 'service.incident_detected', approval: 'rejected', variables: ['serviceName'], sample: 'پارس سرور: اختلال فنی مربوط به سرویس %% شناسایی شده و در حال بررسی است. نتیجه از طریق پنل اطلاع رسانی می شود. parserver.ir' },
  serviceSuspended: { event: 'service.suspended', approval: 'approved-sample', variables: ['serviceName'], sample: 'پارس سرور: سرویس cloud-01 به دلیل عدم تمدید تعلیق شده است. برای بررسی وضعیت به پنل کاربری مراجعه کنید. parserver.ir' },
  serverStoppedNoCredit: { event: 'server.stopped_no_credit', approval: 'approved-sample', variables: ['serviceName'], sample: 'پارس سرور: سرور cloud-01 به علت کمبود اعتبار کیف پول خاموش شد. پس از شارژ کیف پول می توانید از پنل برای روشن کردن سرور اقدام کنید. parserver.ir' },
  walletLowBalance: { event: 'wallet.low_balance', approval: 'approved-sample', variables: ['serviceName'], sample: 'پارس سرور: اعتبار کیف پول شما برای ادامه سرویس cloud-01 کافی نیست. لطفا برای جلوگیری از توقف سرویس، موجودی را افزایش دهید. parserver.ir' },
  serviceExpiring: { event: 'service.expiring', approval: 'approved-sample', variables: ['serviceName','endDate'], sample: 'پارس سرور: دوره سرویس cloud-01 در تاریخ 1405/08/25 پایان می یابد. لطفا وضعیت تمدید و اعتبار خود را بررسی کنید. parserver.ir' },
  serviceRenewed: { event: 'service.renewed', approval: 'approved-sample', variables: ['serviceName','endDate'], sample: 'پارس سرور: سرویس cloud-01 با موفقیت تمدید شد. تاریخ پایان دوره جدید: 1405/09/20 . parserver.ir' },
  provisioningDelayed: { event: 'server.provisioning_delayed', approval: 'approved-sample', variables: ['orderNumber'], sample: 'پارس سرور: آماده سازی سرور مربوط به سفارش ord-202611-000123 با تاخیر مواجه شده و در حال بررسی است. parserver.ir' },
  serverActivated: { event: 'server.activated', approval: 'approved-sample', variables: ['serviceName','serverIp'], sample: 'پارس سرور: سرور cloud-01 با موفقیت فعال شد. ip سرور: 192.0.2.20 . اطلاعات مدیریت در پنل شما موجود است. parserver.ir' },
  orderPaymentFailed: { event: 'order.payment_failed', approval: 'approved-sample', variables: ['orderNumber'], sample: 'پارس سرور: پرداخت سفارش ord-202611-000123 تکمیل نشد. برای بررسی وضعیت و تلاش مجدد به پنل مراجعه کنید. parserver.ir' },
  invoiceIssued: { event: 'invoice.issued', approval: 'approved-sample', variables: ['invoiceNumber','amount'], sample: 'پارس سرور: صورتحساب شماره inv-202611-000123 به مبلغ 850000 تومان صادر شد. جزئیات در پنل کاربری قابل مشاهده است. parserver.ir' },
  orderRefunded: { event: 'order.refunded', approval: 'approved-sample', variables: ['amount','orderNumber'], sample: 'پارس سرور: مبلغ 2980000 تومان بابت سفارش ord-202611-000123 به کیف پول شما بازگردانده شد. parserver.ir' },
  walletCredited: { event: 'wallet.credited', approval: 'approved-sample', variables: ['amount','balance'], sample: 'پارس سرور: مبلغ 1000000 تومان به کیف پول شما اضافه شد. موجودی جدید: 1250000 تومان. parserver.ir' },
  orderPaid: { event: 'order.paid', approval: 'approved-sample', variables: ['orderNumber','amount'], sample: 'پارس سرور: پرداخت سفارش ord-202611-000123 به مبلغ 2980000 تومان تایید شد. سفارش شما در حال پردازش است. parserver.ir' },
  orderCreated: { event: 'order.created', approval: 'approved-sample', variables: ['orderNumber'], sample: 'پارس سرور: سفارش ord-202611-000123 ثبت شد و در انتظار پرداخت است. برای تکمیل خرید به پنل مراجعه کنید. parserver.ir' },
  newLogin: { event: 'account.new_login', approval: 'approved-sample', variables: ['ip'], sample: 'پارس سرور: ورود جدید به حساب شما از ip 192.0.2.15 ثبت شد. اگر شما نبودید، امنیت حساب خود را بررسی کنید. parserver.ir' },
  passwordChanged: { event: 'account.password_changed', approval: 'approved-sample', variables: [], sample: 'پارس سرور: رمز عبور حساب شما تغییر کرد. اگر این تغییر توسط شما انجام نشده است با پشتیبانی تماس بگیرید. parserver.ir' },
} as const satisfies Record<string, ParsGreenTemplate>

export type ParsGreenTemplateKey = keyof typeof PARSGREEN_TEMPLATES

// Confirmed examples in WhiteText on 2026-11-12. The list displays the example
// (Title), not the approved %% pattern (Text). Do not render or send these as
// dynamic templates until the actual approved patterns have been verified.
export const PARSGREEN_AUTH_SAMPLES = {
  phoneVerification: { event: 'account.phone_verification', approval: 'approved-sample', variables: ['code'], sample: 'پارس سرور کد تایید شماره همراه شما: 479125 @parserver.ir #479125' },
  phoneLogin: { event: 'account.phone_login', approval: 'approved-sample', variables: ['code'], sample: 'پارس سرور کد ورود شما: 583164 @parserver.ir #583164' },
  passwordRecovery: { event: 'account.password_recovery', approval: 'approved-sample', variables: ['code'], sample: 'پارس سرور کد بازیابی رمز عبور: 648291 @parserver.ir #648291' },
  accountOperation: { event: 'account.operation_verification', approval: 'approved-sample', variables: ['code'], sample: 'پارس سرور کد تایید عملیات حساب کاربری: 736205 @parserver.ir #736205' },
} as const satisfies Record<string, ParsGreenTemplate>
