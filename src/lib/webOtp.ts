export async function readSmsCode(controller: AbortController): Promise<string | undefined> {
  if (!window.isSecureContext || window.location.protocol !== 'https:' ||
      !('OTPCredential' in window) || !navigator.credentials?.get) return

  const { signal } = controller
  const timer = window.setTimeout(() => controller.abort(), 60_000)
  const clearTimer = () => window.clearTimeout(timer)
  signal.addEventListener('abort', clearTimer, { once: true })
  try {
    const options: CredentialRequestOptions & { otp: { transport: ['sms'] } } = {
      otp: { transport: ['sms'] }, signal,
    }
    const credential = await navigator.credentials.get(options) as (Credential & { code?: string }) | null
    if (!signal.aborted && credential?.code && /^\d{6}$/.test(credential.code)) return credential.code
  } catch {
    // The OTP field is still available when the browser declines the request.
  } finally {
    clearTimer()
    signal.removeEventListener('abort', clearTimer)
  }
}
