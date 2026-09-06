# کنسول کلود سرور

پیاده‌سازی React و TypeScript طراحی داشبورد کلود سرور با رابط راست‌به‌چپ، کامپوننت‌های مشترک و چیدمان واکنش‌گرا.

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

## بک‌اند (Backend)

از نسخه جدید، یک بک‌اند Production-grade در پوشه `backend/` وجود دارد:

- **تکنولوژی:** Node.js 24، TypeScript، Fastify، PostgreSQL + Drizzle ORM، Redis + BullMQ، Argon2id
- **معماری:** پلتفرم چند-پرووایدر (سرویس‌دهنده انتزاعی `CloudProvider`)، اولین پرووایدر واقعی **Leaseweb** با حالت امن `mock` به‌صورت پیش‌فرض
- **مالی:** کیف پول + دفتر کل غیرقابل‌تغییر، فاکتور، اشتراک ماهانه، نرخ ارز و قیمت‌گذاری — همه با اعداد صحیح (ریال/سنت) و بدون float
- **ایمنی:** عملیات خرید idempotent، پروویژن در صف پس‌زمینه، بازیابی (reconciliation) برای نتایج نامشخص، رول‌بک خودکار در دیپلوی

اجرای محلی بک‌اند:

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres + Redis (فقط 127.0.0.1)
cd backend && npm ci && npm run db:migrate && npm run seed
npm run dev          # API روی پورت 8000
npm run dev:worker   # worker (ترمینال دوم)
```

مستندات:

- [docs/BACKEND.md](docs/BACKEND.md) — معماری، دیتابیس، API، اجرای محلی و تست‌ها
- [docs/LEASEWEB.md](docs/LEASEWEB.md) — یکپارچه‌سازی Leaseweb، حالت mock/live و امنیت خرید واقعی
- [docs/BILLING.md](docs/BILLING.md) — کیف پول، دفتر کل، فاکتور، اشتراک ماهانه و قیمت‌گذاری

## استقرار Production (Deployment)

پایپ‌لاین CI/CD و استقرار Docker برای محیط Production در مستند زیر شرح داده شده است:

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

خلاصه: هر پوش به `main` یک تصویر تغییرناپذیر `ghcr.io/hamedsanaei/cloud:sha-<commit>` می‌سازد و آن را روی سرور Production (هم‌راه با Vendora) در `/opt/tofan/cloud` با کانتینر `tofan-cloud` روی پورت محلی `127.0.0.1:8540` و با **رول‌بک خودکار** استقرار می‌دهد.
