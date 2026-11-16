import { SMS_CATALOG, smsSegments } from '../modules/auth/parsgreen-templates.js'

// Synthetic catalog only. Never print env credentials, runtime OTP or recipients.
for (const [key, template] of Object.entries(SMS_CATALOG)) {
  console.log(JSON.stringify({ key, approval: template.approval, ...smsSegments(template.sample) }))
}
for (const [variant, message] of Object.entries({
  previousManual: 'کد ورود پارس سرور: 479125\nاین کد را در اختیار دیگران قرار ندهید.',
  previousBound: 'کد ورود پارس سرور: 479125\nاین کد را در اختیار دیگران قرار ندهید.\n@parserver.ir #479125',
  compactBound: SMS_CATALOG.phoneLogin.sample,
})) console.log(JSON.stringify({ variant, ...smsSegments(message) }))
