import { ParserverEnamadSeal } from '../components/ParserverEnamadSeal'
import { ParserverTabaPaySeal } from '../components/ParserverTabaPaySeal'
import { Link } from 'react-router-dom'
import { BRAND_NAME, BrandMark } from '../components/Brand'
import { HomeTariffs } from '../components/HomeTariffs'
import { useAuth } from '../auth/AuthContext'

const faqs = [
  ['سرور ارزان هتزنر کدام است؟', 'گزینهٔ کم‌هزینه به منابع، موقعیت و دورهٔ پرداخت شما بستگی دارد. جدول، فقط پلن‌های واقعاً منتشرشدهٔ پارس سرور را از کم‌هزینه به بیشتر مقایسه می‌کند؛ ادعای ارزان‌ترین قیمت بازار یا تخفیف دائمی نداریم. اگر قیمت معتبر موجود نباشد، مبلغی حدس نمی‌زنیم.'],
  ['هزینهٔ سرور هتزنر ساعتی چطور محاسبه می‌شود؟', 'هر ساعت جدید با نرخ ارز معتبر و قواعد قیمت‌گذاری همان زمان محاسبه می‌شود. برداشت واقعی دقیق و برحسب ریال است. خاموش‌کردن ماشین به‌تنهایی تضمین توقف هزینهٔ ارائه‌دهنده نیست؛ وضعیت صورتحساب و حذف تأییدشده را در پنل بررسی کنید.'],
  ['پرداخت ماهانه چه مزیتی دارد؟', 'مبلغ پذیرفته‌شده برای کل ماه پرداخت‌شده ثابت می‌ماند. تغییر نرخ ارز در میانهٔ این دوره هزینهٔ اضافه ایجاد نمی‌کند؛ قیمت دورهٔ بعد هنگام تمدید با تعرفهٔ معتبر آن دوره مشخص می‌شود.'],
  ['قیمت تومان به نرخ دلار وابسته است؟', 'قیمت تومانی از ارز اعلام‌شدهٔ ارائه‌دهنده و نرخ تبدیل مصوب فروشگاه محاسبه می‌شود. همهٔ محصولات الزاماً دلاری نیستند؛ قیمت یورویی نیز به نرخ معتبر یورو نیاز دارد. تغییر نرخ می‌تواند قیمت ساعت‌های بعد یا تمدید بعدی را تغییر دهد.'],
  ['برای سایت یا سرویس شبکه چه منابع و لوکیشنی مناسب است؟', 'برای سایت کم‌ترافیک، ابتدا مصرف واقعی CPU، RAM و دیسک را اندازه بگیرید. برای پایگاه داده، حافظه و کارایی دیسک اهمیت بیشتری دارند. در سرویس شبکه، تأخیر تا کاربران، سهمیهٔ ترافیک، نوع IP و شرایط استفادهٔ ارائه‌دهنده را بررسی کنید؛ مناسب‌بودن برای هر کاربرد به همین محدودیت‌ها وابسته است.'],
  ['آیا نرخ ساعتی را باید در عدد ثابتی ضرب کنم تا قیمت ماهانه به دست آید؟', 'خیر. دو ستون جدول، دوره‌های واقعی عرضه‌شده را نشان می‌دهند. اگر پلن ماهانهٔ مستقلی وجود نداشته باشد، مبلغ ماهانه ساخته نمی‌شود. برای مصرف ساعتی، هزینهٔ آینده به مدت استفاده و نرخ‌های معتبر آن ساعت‌ها وابسته است.'],
]

export function HetznerPage({ initialTariffs }: { initialTariffs?: string }) {
  const { user } = useAuth()
  return <div className="landing-page hetzner-page" dir="rtl">
    <header className="landing-header"><nav className="landing-nav" aria-label="ناوبری هتزنر">
      <Link className="public-logo" to="/"><BrandMark /><strong>{BRAND_NAME}</strong></Link>
      <div className="hetzner-nav"><a href="#tariffs">قیمت پلن‌ها</a><a href="#hetzner-guide">راهنمای انتخاب</a><a href="#hetzner-faq">پرسش‌ها</a><Link to="/#iran-server">سرور ایران</Link></div>
      <Link className="button primary" to={user ? '/dashboard' : '/login'}>{user ? 'پنل مدیریت' : 'ورود به حساب'}</Link>
    </nav></header>
    <main>
      <nav className="public-container public-breadcrumb" aria-label="مسیر صفحه"><Link to="/">خانه</Link><span aria-hidden="true"> / </span><span aria-current="page">سرور هتزنر</span></nav>
      <section className="landing-section public-container hetzner-intro">
        <h1>خرید سرور هتزنر؛ مقایسهٔ پلن‌های ساعتی و ماهانه</h1>
        <p>برای انتخاب یک سرور ارزان هتزنر، مبلغ را کنار منابع و نیاز واقعی‌تان ببینید. این صفحه، قیمت فروشگاهی پلن‌های قابل سفارش را با موقعیت، پردازنده، حافظه، دیسک و ترافیک مقایسه می‌کند؛ موجودی و قیمت نهایی پیش از خرید دوباره بررسی می‌شوند.</p>
        <a className="button primary large" href="#tariffs">مقایسهٔ قیمت و انتخاب پلن</a>
        <p>انتخاب پلن، موقعیت و دوره هنگام ورود یا ثبت‌نام حفظ می‌شود. ثبت سفارش فقط پس از تأیید پیش‌فاکتور و بررسی موجودی کیف پول انجام می‌شود.</p>
      </section>
      <HomeTariffs initialHtml={initialTariffs} scope="hetzner" />
      <section id="hetzner-guide" className="landing-section public-container">
        <h2>چطور هزینه را کم کنیم، بدون انتخاب منابع ناکافی؟</h2>
        <div className="feature-grid">
          <article><h3>CPU و حافظه را با بار واقعی بسنجید</h3><p>پلن کوچک‌تر هزینهٔ کمتری دارد، اما اشباع پردازنده یا کمبود RAM می‌تواند سایت را کند کند. برای شروع، بار پایگاه داده و برنامه را اندازه بگیرید؛ هزینهٔ کاهش کارایی را هم در مقایسه لحاظ کنید.</p></article>
          <article><h3>فقط ظرفیت دیسک را مقایسه نکنید</h3><p>نوع دیسک و نیاز به فضای ذخیره‌سازی بر انتخاب اثر دارد. اطلاعات اعلام‌شدهٔ هر پلن در جدول آمده است؛ برای داده‌های مهم، هزینه و روش پشتیبان‌گیری را جداگانه بررسی کنید.</p></article>
          <article><h3>موقعیت و شبکه را کنار قیمت ببینید</h3><p>موقعیت‌های واقعاً موجود در فیلتر جدول نمایش داده می‌شوند. نزدیک‌ترین دیتاسنتر جغرافیایی همیشه کمترین تأخیر را ندارد؛ مسیر شبکه تا مخاطب، ترافیک مشمول و هزینهٔ گزینه‌های IP را بررسی کنید.</p></article>
        </div>
        <h2>سرور هتزنر ساعتی یا ماهانه؟</h2>
        <p>برای آزمایش کوتاه‌مدت یا بار موقت، انعطاف دورهٔ ساعتی مفید است. برای سرویس همیشه‌روشن، پلن ماهانهٔ واقعی را ـ اگر عرضه می‌شود ـ با برآورد مصرف مقایسه کنید. مبلغ ماه پرداخت‌شده ثابت است؛ ساعت‌های جدید و تمدید ماه بعد می‌توانند با تغییر نرخ معتبر ارز قیمت متفاوتی داشته باشند.</p>
        <p>قیمت جدول جایگزین پیش‌فاکتور نیست. مالیاتِ تنظیم‌شده در محاسبه لحاظ می‌شود و گزینه‌های اضافی، محدودیت منابع و حداقل اعتبار لازم پیش از تأیید خرید در پنل مشخص می‌شوند.</p>
        <a href="#tariffs">بازگشت به مقایسهٔ پلن‌های موجود</a>
      </section>
      <section id="hetzner-faq" className="landing-section public-container hetzner-faq"><h2>پرسش‌های خرید سرور هتزنر</h2>
        {faqs.map(([question, answer]) => <article key={question}><h3>{question}</h3><p>{answer}</p></article>)}
      </section>
    </main>
    <footer className="landing-footer"><div className="public-container"><div className="landing-footer-brand"><Link className="public-logo inverse" to="/"><BrandMark /><strong>{BRAND_NAME}</strong></Link><p>مقایسهٔ منابع و قیمت؛ انتخاب با پیش‌فاکتور معتبر.</p></div><nav aria-label="پیوندهای خدمات"><Link to="/">صفحهٔ اصلی</Link><a href="#tariffs">خرید سرور هتزنر</a><Link to="/#iran-server">تعرفهٔ سرور ایران</Link></nav><div className="landing-footer-trust" aria-label="نمادهای اعتماد"><ParserverEnamadSeal /><ParserverTabaPaySeal /></div><small>© {BRAND_NAME} — تمامی حقوق محفوظ است.</small></div></footer>
  </div>
}
