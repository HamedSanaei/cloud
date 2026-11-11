# کنسول کلود سرور

پیاده‌سازی React و TypeScript طراحی داشبورد کلود سرور با رابط راست‌به‌چپ، کامپوننت‌های مشترک و چیدمان واکنش‌گرا.

یکپارچگی کیف پول، تعرفه و مدیریت سرور با ربات تلگرام، همراه با سرور آزمایشی
سوپرادمین‌ها (`leaseweb-test`، شناسه `12717238`، IPv4 `217.20.121.89`) در
[راهنمای اتصال پلتفرم](docs/PLATFORM_INTEGRATION.md) توضیح داده شده است.
فعال‌سازی نیازمند تطبیق دارایی‌های قبلی و تنظیم `PLATFORM_API_URL` است؛ خودکار انجام نمی‌شود.

## اجرا

پیش‌نیاز: Node.js نسخهٔ ۲۴ یا جدیدتر.

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

صفحهٔ ساخت سرور از کاتالوگ زندهٔ ارائه‌دهندگان استفاده می‌کند؛ بدون API، دیتاسنتر و پلن ساختگی نمایش داده نمی‌شود.

## بک‌اند (Backend)

از نسخه جدید، یک بک‌اند Production-grade در پوشه `backend/` وجود دارد:

- **تکنولوژی:** Node.js 24، TypeScript، Fastify، PostgreSQL + Drizzle ORM، Redis + BullMQ، Argon2id
- **ارائه‌دهندگان:** هتزنر با مسیریابی چند اکانت، لیزوب VPS و Cloud با چند اکانت و چند لوکیشن؛ تنظیمات خصوصی در `configuration.toml` مطابق `configuration.example.toml`.
- **مالی:** موجودی و برداشت کاربر تومانی با دفتر کل ریالی؛ USD و USDT با برابری یک‌به‌یک و نرخ تازهٔ تتر به ریال، قیمت دقیق زیرسنتی و snapshot ثابت سفارش.
- **ایمنی:** خرید idempotent، پروویژن صف‌شده، بازیابی نتایج نامشخص و Rollback مشروط به سازگاری schema و قرارداد مالی.
- **کنترل اعتبار:** درخواست خاموشی واقعی هنگام ناکافی‌بودن اعتبار یک ساعتِ سرورهای ساعتی هر کیف پول، جلوگیری از روشن‌کردن تا شارژ کافی، و هشدار پنل هر شش ساعت برای کمبود اعتبار سه روز آینده.

اجرای محلی بک‌اند:

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres + Redis (فقط 127.0.0.1)
cd backend && npm ci && npm run db:migrate && npm run seed
npm run dev          # API روی پورت 8000
npm run dev:worker   # worker (ترمینال دوم)
```

برای ارائهٔ واقعی پلن‌ها، `configuration.example.toml` را به `configuration.toml` کپی و اکانت‌ها را تنظیم کنید. ترتیب ساخت: دیتاسنتر و موقعیت ← دوره پرداخت ← نوع و منابع سرور ← سیستم عامل ← کیف پول ← تأیید. روزانه معادل ۲۴ ساعت سرویس ساعتی است؛ VPS پیش‌پرداخت ماهانه با برچسب ساعتی فروخته نمی‌شود. آسیاتک تا زمان وجود API و اطلاعات اتصال واقعی غیرفعال می‌ماند.

مستندات:

- [docs/BACKEND.md](docs/BACKEND.md) — معماری، دیتابیس، API، اجرای محلی و تست‌ها
- [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) — ورود گوگل، OTP ایمیل و ParsGreen، بازیابی رمز و 2FA
- [docs/LEASEWEB.md](docs/LEASEWEB.md) — یکپارچه‌سازی Leaseweb، حالت mock/live و امنیت خرید واقعی
- [docs/BILLING.md](docs/BILLING.md) — کیف پول، دفتر کل، فاکتور، دوره‌های اشتراک و قیمت‌گذاری

## استقرار Production (Deployment)

پایپ‌لاین CI/CD و استقرار Docker برای محیط Production در مستند زیر شرح داده شده است:

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

طبق سیاست صریح اپراتور، `staging` فقط مسیر انتشار سریع است: پس از CI کامل همان سایت، دیتابیس و ربات اصلی را به‌روز می‌کند؛ محیط یا poller دوم ساخته نمی‌شود. پوش معمولی `main` به‌تنهایی استقرار نمی‌دهد؛ مسیر دستی main نیازمند تأیید صریح Workflow و Environment است. Secrets استقرار را اپراتور تنظیم می‌کند. Backup رمزگذاری‌شده پیش از Migration، قفل مشترک سایت/ربات و health/readiness پس از انتشار الزامی‌اند؛ Rollback هرگز schema یا دورهٔ مالی را خودکار عقب نمی‌برد.
