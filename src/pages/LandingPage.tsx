import { ArrowLeft, Check, ChevronDown, Clock3, Globe2, Menu, Network, Settings2, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { BRAND_NAME, BrandMark } from '../components/Brand'
import { ParserverEnamadSeal } from '../components/ParserverEnamadSeal'
import { ParserverTabaPaySeal } from '../components/ParserverTabaPaySeal'
import { HomeTariffs } from '../components/HomeTariffs'

const HETZNER_ACCOUNT_URL = 'https://pluspremium.ir/'
const kalamehVersion = import.meta.env.VITE_KALAMEH_VERSION
const kalamehStylesheet = /^[a-f0-9]{64}$/.test(kalamehVersion ?? '') ? `/kalameh/${kalamehVersion}/home.css` : '/kalameh/home.css'

const providers = [
  { id: 'asiatech', name: 'آسیاتک', logo: '/providers/asiatech.svg', region: 'ایران', title: 'خرید سرور ایران', tone: 'blue', link: '#iran-server', action: 'وضعیت عرضه و تعرفهٔ ایران', bullets: ['میزبانی در ایران برای مخاطبان داخل کشور', 'تعرفهٔ ماهانهٔ منابع پس از تأیید منتشر می‌شود'] },
  { id: 'hetzner', name: 'Hetzner', logo: '/providers/hetzner.svg', region: 'اروپا، آمریکا و سنگاپور', title: 'خرید سرور هتزنر', tone: 'rose', link: '/hetzner#tariffs', action: 'مشاهدهٔ پلن‌های هتزنر', bullets: ['مقایسهٔ موقعیت، منابع و ترافیک مشمول', 'دوره‌های پرداخت مطابق پلن‌های قابل سفارش'] },
  { id: 'leaseweb', name: 'Leaseweb', logo: '/providers/leaseweb.svg', region: 'خارج', title: 'سرور ابری لیزوب', tone: 'cyan', link: '/servers/create', action: 'بررسی موجودی لیزوب در پنل', bullets: ['موقعیت و دورهٔ پرداخت در پنل سفارش مشخص می‌شود'] },
]

function ProviderLogo({ provider, alt }: { provider: string; alt: string }) {
  return <img alt={alt} loading="lazy" width="48" height="48" src={`/providers/${provider}.svg`} />
}

export function LandingPage({ initialTariffs }: { initialTariffs?: string } = {}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { user } = useAuth()
  return (
    <div className="landing-page landing-home" dir="rtl">
      <link rel="stylesheet" href={kalamehStylesheet} precedence="default" />
      <header className="landing-header">
        <nav className="landing-nav" aria-label="ناوبری اصلی">
          <Link className="public-logo" to="/"><BrandMark /><strong>{BRAND_NAME}</strong></Link>
          <button aria-label="نمایش فهرست" className="landing-menu-button" onClick={() => setMenuOpen((value) => !value)}>{menuOpen ? <X /> : <Menu />}</button>
          <div className={`landing-links ${menuOpen ? 'open' : ''}`}>
            <a href="/hetzner">سرور هتزنر</a><a href="#servers">سرور ابری</a><a href="#datacenters">دیتاسنترها</a><a href="#tariffs">تعرفه‌ها</a><a href="#hourly">پرداخت ساعتی</a>
          </div>
          <div className={`landing-auth-actions ${user ? 'landing-auth-actions--signed-in' : ''}`}>{user ? <Link className="button primary" to="/dashboard">ورود به پنل مدیریت</Link> : <><Link className="button ghost" to="/login">ورود</Link><Link className="button primary" to="/register">ثبت‌نام</Link></>}</div>
        </nav>
      </header>

      <main>
        <section className="landing-hero public-container">
          <div className="hero-copy">
            <span className="eyebrow">ایران • اروپا</span>
            <h1>سرور ابری ایران و هتزنر</h1>
            <p className="hero-tagline">با پرداخت ریالی و امکان خرید به صورت ساعتی</p>
            <p>مشخصات و قیمت پلن‌های قابل سفارش هتزنر را مقایسه کنید و وضعیت عرضه و تعرفهٔ سرور ایران را ببینید.</p>
            <div className="hero-actions"><Link className="button primary large" to={user ? '/servers/create' : '/register'}>شروع ساخت سرور</Link><Link className="button dark large" to={user ? '/dashboard' : '/login'}>{user ? 'پنل مدیریت' : 'ورود به حساب'}</Link></div>
            <ul className="hero-trust"><li><Check /> مقایسهٔ دوره‌های پرداخت</li><li><Check /> مشخصات شبکهٔ هر پلن</li><li><Check /> موقعیت‌های متنوع</li></ul>
          </div>
          <div className="hero-console" aria-label="نمایی از کنسول مدیریت سرور">
            <div className="console-window-bar"><span><i /><i /><i /></span><b>کنسول مدیریت سرور</b></div>
            <div className="console-summary"><strong>۳</strong><span>نمایش شماتیک پنل</span><i /></div>
            {providers.map((provider) => <div className="console-server" key={provider.id}><ProviderLogo alt="" provider={provider.id} /><span><b>{provider.name}</b><small>{provider.region}</small></span><i /></div>)}
            <ul className="console-capabilities" aria-label="امکانات سرویس">
              <li><Clock3 aria-hidden="true" /><span><strong>پرداخت ساعتی</strong><small>متناسب با مصرف شما</small></span></li>
              <li><Network aria-hidden="true" /><span><strong>شبکه و ترافیک</strong><small>براساس مشخصات پلن</small></span></li>
            </ul>
          </div>
        </section>

        <section className="landing-section public-container" id="datacenters">
          <div className="landing-section-heading"><span>دیتاسنترهای شناخته‌شده</span><h2>دیتاسنترهای منتخب، یک تجربه یکپارچه</h2></div>
          <div className="provider-logo-row">{providers.map((provider) => <div key={provider.id}><img alt={provider.name} src={provider.logo} /></div>)}</div>
          <p className="section-note">تعرفه‌ها و امکان ثبت سفارش به موقعیت و پلن فعال بستگی دارد.</p>
        </section>

        <section className="landing-section public-container" id="servers">
          <div className="landing-section-heading"><h2>انتخاب موقعیت سرور</h2><p>موقعیت، ظرفیت و دورهٔ پرداخت را برای کاربرد خود مقایسه کنید.</p></div>
          <div className="server-offer-grid">
            {providers.map((provider) => (
              <article className={`server-offer ${provider.tone}`} key={provider.id}>
                <div className="server-offer-brand"><span>{provider.region} · {provider.name}</span><img alt={provider.name} src={provider.logo} /></div>
                <div className="server-offer-body"><h3>{provider.title}</h3><ul>{provider.bullets.map((bullet) => <li key={bullet}><i />{bullet}</li>)}</ul><a className="button primary" href={provider.link}>{provider.action}<ArrowLeft size={16} /></a></div>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section public-container" id="features">
          <div className="landing-section-heading"><span>چرا {BRAND_NAME}؟</span><h2>زیرساخت منعطف، مدیریت ساده</h2></div>
          <div className="feature-grid">
            <article><span><Clock3 /></span><h3>پرداخت ساعتی</h3><p>منابع سرور را به‌اندازه نیاز فعال کنید و هزینه را متناسب با مدت استفاده بپردازید.</p></article>
            <article><span><Network /></span><h3>امکانات شبکه</h3><p>پشتیبانی IPv6 و سهمیهٔ ترافیک را در مشخصات هر پلن بررسی کنید.</p></article>
            <article><span><Settings2 /></span><h3>مدیریت یکپارچه</h3><p>سرورها، دامنه‌ها، آی‌پی‌ها و پرداخت‌ها را از یک پنل سریع و فارسی مدیریت کنید.</p></article>
          </div>
        </section>

        <HomeTariffs initialHtml={initialTariffs} />

        <section className="ipv6-banner public-container" id="hourly">
          <div><h2>سرور هتزنر ساعتی یا ماهانه؟</h2><p>برای آزمایش یا کار کوتاه‌مدت، نرخ هر ساعت را بررسی کنید. برای سرویس همیشه‌روشن، اگر پلن ماهانه عرضه می‌شود، مبلغ همان دوره را با هزینهٔ مورد انتظار مصرف مقایسه کنید.</p><a href="/hetzner#tariffs">راهنمای انتخاب و مقایسهٔ تعرفه‌های هتزنر <ArrowLeft size={16} /></a></div>
          <div className="ipv6-visual"><Globe2 /><strong dir="ltr">2001:db8::/32</strong><small>نسل جدید آدرس‌های اینترنت</small></div>
        </section>

        <section className="landing-cta public-container">
          <div><span>آماده‌اید شروع کنید؟</span><h2>سرور بعدی شما، چند کلیک فاصله دارد.</h2><p>{user ? 'دیتاسنتر دلخواه را انتخاب کنید و سرور بعدی خود را بسازید.' : 'حساب خود را بسازید، دیتاسنتر دلخواه را انتخاب کنید و سرور سازمان را مدیریت کنید.'}</p></div>
          <div><Link className="button primary large" to={user ? '/servers/create' : '/register'}>{user ? 'ایجاد سرور جدید' : 'ساخت حساب'}</Link><Link className="button ghost large" to={user ? '/dashboard' : '/login'}>ورود به پنل</Link></div>
        </section>

        <section className="landing-section public-container landing-faq">
          <div className="landing-section-heading"><span>پرسش‌های متداول</span><h2>قبل از شروع، بیشتر بدانید</h2></div>
          {[['سرور ایران برای چه کاربردی مناسب است؟', 'نزدیکی به کاربران داخل کشور می‌تواند تأخیر را کاهش دهد. پیش از سفارش، وضعیت عرضه، ترافیک ورودی و خروجی و نیاز به IP را بررسی کنید.'], ['چطور یک سرور ارزان هتزنر انتخاب کنم؟', 'منابع موردنیاز و دورهٔ پرداخت را مقایسه کنید؛ ارزان‌بودن فقط نسبت به همین فهرست و زمان بررسی معنا دارد. راهنمای هتزنر، جدول قیمت و محدودیت‌های هر انتخاب را توضیح می‌دهد.'], ['آیا خرید سرور به حساب مستقل هتزنر نیاز دارد؟', 'سرور را از پنل پارس سرور سفارش و مدیریت می‌کنید. برای پیگیری خرید حساب مستقل، به وب‌سایت پلاس پریمیوم مراجعه کنید.']].map(([question, answer]) => <details key={question}><summary>{question}<ChevronDown /></summary><p>{answer}</p></details>)}
          <p><a href="/hetzner">راهنمای خرید سرور هتزنر و انتخاب پلن کم‌هزینه</a></p>
          <p className="landing-account-link"><a className="button primary" href={HETZNER_ACCOUNT_URL} rel="sponsored">خرید اکانت هتزنر <ArrowLeft size={16} /></a> <span>مشاهده در وب‌سایت پلاس پریمیوم</span></p>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="public-container">
          <div className="landing-footer-brand">
            <Link className="public-logo inverse" to="/"><BrandMark /><strong>{BRAND_NAME}</strong></Link>
            <p>پنل فارسی مدیریت زیرساخت و میزبانی ابری.</p>
          </div>
          <nav aria-label={`خدمات ${BRAND_NAME}`}>
            <a href="#iran-server">سرور ایران</a>
            <a href="/hetzner">سرور هتزنر</a>
            <a href="#hourly">سرور ساعتی و ماهانه</a>
            <a href="#tariffs">تعرفه‌ها</a>
            <a href={HETZNER_ACCOUNT_URL} rel="sponsored">خرید اکانت هتزنر</a>
          </nav>
          <div className="landing-footer-trust" aria-label="نمادهای اعتماد">
            <ParserverEnamadSeal />
            <ParserverTabaPaySeal />
          </div>
          <small>© {BRAND_NAME} — تمامی حقوق محفوظ است.</small>
        </div>
      </footer>
    </div>
  )
}
