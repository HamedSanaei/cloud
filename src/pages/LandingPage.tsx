import { ArrowLeft, Check, ChevronDown, Clock3, Globe2, Menu, Network, Settings2, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { BRAND_NAME, BrandMark } from '../components/Brand'

const providers = [
  { id: 'asiatech', name: 'آسیاتک', logo: '/providers/asiatech.svg', region: 'ایران', title: 'سرور ابری ایران', tone: 'blue', bullets: ['میزبانی در دیتاسنتر آسیاتک', 'قابلیت استفاده از IPv4 و IPv6', 'پرداخت ساعتی متناسب با استفاده'] },
  { id: 'hetzner', name: 'Hetzner', logo: '/providers/hetzner.svg', region: 'آلمان', title: 'سرور ابری هتزنر', tone: 'rose', bullets: ['ارائه از دیتاسنتر Hetzner آلمان', 'پشتیبانی از IPv6 روی سرور', 'امکان تهیه ساعتی یا پرداخت ماهانه'] },
  { id: 'leaseweb', name: 'Leaseweb', logo: '/providers/leaseweb.svg', region: 'خارج', title: 'سرور ابری لیزوب', tone: 'cyan', bullets: ['ارائه سرور از دیتاسنتر Leaseweb', 'امکان IPv6 برای سرویس‌ها', 'محاسبه هزینه به‌صورت ساعتی'] },
]

function ProviderLogo({ provider, alt }: { provider: string; alt: string }) {
  return <img alt={alt} loading="lazy" src={`/providers/${provider}.svg`} />
}

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false)
  const { user } = useAuth()
  return (
    <div className="landing-page" dir="rtl">
      <header className="landing-header">
        <nav className="landing-nav" aria-label="ناوبری اصلی">
          <Link className="public-logo" to="/"><BrandMark /><strong>{BRAND_NAME}</strong></Link>
          <button aria-label="نمایش فهرست" className="landing-menu-button" onClick={() => setMenuOpen((value) => !value)}>{menuOpen ? <X /> : <Menu />}</button>
          <div className={`landing-links ${menuOpen ? 'open' : ''}`}>
            <a href="#servers">سرور ابری</a><a href="#datacenters">دیتاسنترها</a><a href="#features">امکانات</a><a href="#hourly">پرداخت ساعتی</a>
          </div>
          <div className={`landing-auth-actions ${user ? 'landing-auth-actions--signed-in' : ''}`}>{user ? <Link className="button primary" to="/dashboard">ورود به پنل مدیریت</Link> : <><Link className="button ghost" to="/login">ورود</Link><Link className="button primary" to="/register">ثبت‌نام</Link></>}</div>
        </nav>
      </header>

      <main>
        <section className="landing-hero public-container">
          <div className="hero-copy">
            <span className="eyebrow">ایران • اروپا</span>
            <h1>سرور ابری برای<br /><em>ایده‌های بزرگ شما</em></h1>
            <p>از دیتاسنترهای ایران و اروپا، سرور دلخواهتان را انتخاب کنید؛ با پرداخت ساعتی و امکان IPv6، کنترل زیرساخت در دست شماست.</p>
            <div className="hero-actions"><Link className="button primary large" to={user ? '/servers/create' : '/register'}>شروع ساخت سرور</Link><Link className="button dark large" to={user ? '/dashboard' : '/login'}>{user ? 'پنل مدیریت' : 'ورود به حساب'}</Link></div>
            <ul className="hero-trust"><li><Check /> پرداخت به‌اندازه مصرف</li><li><Check /> دسترسی به IPv6</li><li><Check /> دیتاسنترهای متنوع</li></ul>
          </div>
          <div className="hero-console" aria-label="نمایی از کنسول مدیریت سرور">
            <div className="console-window-bar"><span><i /><i /><i /></span><b>کنسول مدیریت سرور</b></div>
            <div className="console-summary"><strong>۳</strong><span>سرویس‌های فعال</span><i /></div>
            {providers.map((provider) => <div className="console-server" key={provider.id}><ProviderLogo alt="" provider={provider.id} /><span><b>{provider.name}</b><small>{provider.region} · IPv6</small></span><i /></div>)}
            <span className="console-badge badge-hourly">پرداخت منعطف<br /><b>ساعتی / 24/7</b></span>
            <span className="console-badge badge-ipv6"><b>IPv6</b><br />ایران و خارج</span>
          </div>
        </section>

        <section className="landing-section public-container" id="datacenters">
          <div className="landing-section-heading"><span>دیتاسنترهای شناخته‌شده</span><h2>دیتاسنترهای منتخب، یک تجربه یکپارچه</h2></div>
          <div className="provider-logo-row">{providers.map((provider) => <div key={provider.id}><img alt={provider.name} src={provider.logo} /></div>)}</div>
          <p className="section-note">ارائه سرور از آسیاتک در ایران و Hetzner و Leaseweb در خارج از کشور</p>
        </section>

        <section className="landing-section public-container" id="servers">
          <div className="landing-section-heading"><span>انتخاب هوشمند سرور</span><h2>سرور مورد نیازتان را از بهترین موقعیت انتخاب کنید</h2><p>زیرساخت ایران یا خارج را با انتخاب دیتاسنتر، منابع و روش پرداخت دلخواه بسازید.</p></div>
          <div className="server-offer-grid">
            {providers.map((provider) => (
              <article className={`server-offer ${provider.tone}`} key={provider.id}>
                <div className="server-offer-brand"><span>{provider.region} · {provider.name}</span><img alt={provider.name} src={provider.logo} /></div>
                <div className="server-offer-body"><h3>{provider.title}</h3><p>زیرساخت ابری پایدار برای راه‌اندازی سریع سرویس</p><ul>{provider.bullets.map((bullet) => <li key={bullet}><i />{bullet}</li>)}</ul><Link className="button primary" to={user ? '/servers/create' : '/register'}>انتخاب {provider.name}<ArrowLeft size={16} /></Link></div>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section public-container" id="features">
          <div className="landing-section-heading"><span>چرا {BRAND_NAME}؟</span><h2>زیرساخت منعطف، مدیریت ساده</h2></div>
          <div className="feature-grid">
            <article><span><Clock3 /></span><h3>پرداخت ساعتی</h3><p>منابع سرور را به‌اندازه نیاز فعال کنید و هزینه را متناسب با مدت استفاده بپردازید.</p></article>
            <article><span><Network /></span><h3>IPv6 در ایران و خارج</h3><p>در هر دو موقعیت ایران و خارج از کشور، امکان استفاده از آدرس‌های نسل جدید را داشته باشید.</p></article>
            <article><span><Settings2 /></span><h3>مدیریت یکپارچه</h3><p>سرورها، دامنه‌ها، آی‌پی‌ها و پرداخت‌ها را از یک پنل سریع و فارسی مدیریت کنید.</p></article>
          </div>
        </section>

        <section className="ipv6-banner public-container" id="hourly">
          <div><span className="eyebrow">شبکه آماده برای فردا</span><h2>IPv6 از ایران تا خارج</h2><p>چه سرور ایران را انتخاب کنید، چه دیتاسنترهای خارج؛ امکان استفاده از IPv6 کنار زیرساخت سرویس برایتان فراهم است.</p><a href="#servers">یک انتخاب آینده‌نگر برای شبکه و اپلیکیشن‌های شما <ArrowLeft size={16} /></a></div>
          <div className="ipv6-visual"><Globe2 /><strong dir="ltr">2001:db8::/32</strong><small>نسل جدید آدرس‌های اینترنت</small></div>
        </section>

        <section className="landing-cta public-container">
          <div><span>آماده‌اید شروع کنید؟</span><h2>سرور بعدی شما، چند کلیک فاصله دارد.</h2><p>{user ? 'دیتاسنتر دلخواه را انتخاب کنید و سرور بعدی خود را بسازید.' : 'حساب خود را بسازید، دیتاسنتر دلخواه را انتخاب کنید و سرور سازمان را مدیریت کنید.'}</p></div>
          <div><Link className="button primary large" to={user ? '/servers/create' : '/register'}>{user ? 'ایجاد سرور جدید' : 'ساخت حساب'}</Link><Link className="button ghost large" to={user ? '/dashboard' : '/login'}>ورود به پنل</Link></div>
        </section>

        <section className="landing-section public-container landing-faq">
          <div className="landing-section-heading"><span>پرسش‌های متداول</span><h2>قبل از شروع، بیشتر بدانید</h2></div>
          {[['آیا سرورهای ایران هم IPv6 دارند؟', 'بله، امکان ارائه IPv6 برای سرویس‌های ایران و خارج در نظر گرفته شده است.'], ['هزینه سرور چگونه محاسبه می‌شود؟', 'هزینه متناسب با دوره انتخابی و میزان استفاده از سرویس محاسبه می‌شود.'], ['کدام دیتاسنترها قابل انتخاب هستند؟', 'سرور ایران از آسیاتک و سرور خارج از Hetzner و Leaseweb ارائه می‌شود.']].map(([question, answer]) => <details key={question}><summary>{question}<ChevronDown /></summary><p>{answer}</p></details>)}
        </section>
      </main>

      <footer className="landing-footer"><div className="public-container"><div><Link className="public-logo inverse" to="/"><BrandMark /><strong>{BRAND_NAME}</strong></Link><p>میزبانی ابری در ایران و خارج، با پرداخت منعطف و امکانات شبکه روز.</p></div><nav><a href="#servers">سرور ایران</a><a href="#servers">سرور خارج</a><a href="#hourly">سرور ساعتی</a><a href="#features">IPv6</a></nav><small>© {BRAND_NAME} — تمامی حقوق محفوظ است.</small></div></footer>
    </div>
  )
}
