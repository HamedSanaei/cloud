(() => {
  // Use a fixed gateway origin, never a caller-supplied redirect URL.
  // The payment token stays in the fragment (not in server/CDN logs).
  const raw = window.location.hash.slice(1);
  const match = /^(sandbox\/)?pay\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw);
  const status = document.getElementById('status');
  const link = document.getElementById('continue');
  if (!match || !status || !link) {
    if (status) status.textContent = 'لینک پرداخت معتبر نیست؛ از کیف پول درخواست جدید ایجاد کنید.';
    return;
  }
  const gateway = 'https://api.tabapay.ir/' + (match[1] ? 'sandbox/' : '') + 'pay/' + match[2].toLowerCase();
  link.href = gateway;
  link.hidden = false;
  status.textContent = 'در صورت انجام نشدن انتقال خودکار، روی «ادامه پرداخت» بزنید.';
  // A top-level navigation from an HTTPS parserver.ir document sends its origin
  // as Referer under the explicit referrer policy above.
  window.location.replace(gateway);
})();
