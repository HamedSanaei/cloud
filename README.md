# کنسول میزبان آنلاین

پیاده‌سازی React و TypeScript طراحی داشبورد میزبان آنلاین با رابط راست‌به‌چپ، کامپوننت‌های مشترک و چیدمان واکنش‌گرا.

## اجرا

پیش‌نیاز: Node.js نسخه ۲۰ یا جدیدتر.

```bash
npm install
npm run dev
```

سپس آدرس زیر را باز کنید:

```text
http://localhost:5173
```

## خروجی production

```bash
npm run build
npm run preview
```

خروجی نهایی در پوشه `dist` ایجاد می‌شود.

## مسیرهای اصلی

- `/dashboard`
- `/tickets`
- `/wallet`
- `/invoices`
- `/charge-requests`
- `/servers` و `/servers/create`
- `/ips`
- `/traffic-packages`
- `/domains` و `/domains/register`
- `/profile/update`
- `/sessions`
- `/settings`
- `/changelog`

## ساختار پروژه

- `src/components/layout`: پوسته، منوی کناری و نوار بالایی
- `src/components/ui`: کامپوننت‌های عمومی فرم، کارت، Modal، Stepper و حالت‌ها
- `src/pages`: صفحات و جریان‌های محصول
- `src/data`: تنظیمات ناوبری و جستجوی سراسری
- `src/styles.css`: Design Tokenها و قواعد responsive و dark mode

این نسخه Frontend مستقل است و برای نمایش داده‌ها از حالت‌های نمونه استفاده می‌کند. اتصال به API را می‌توان بدون تغییر ساختار صفحات در لایه داده اضافه کرد.
