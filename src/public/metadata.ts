export const PUBLIC_ORIGIN = 'https://parserver.ir'
export const publicPages = {
  '/': { title: 'خرید سرور ابری ایران و هتزنر | پارس سرور', description: 'پلن‌های قابل سفارش هتزنر را با مشخصات و قیمت ساعتی و ماهانه مقایسه کنید؛ وضعیت عرضه و تعرفهٔ منابع سرور ایران و پنل فارسی مدیریت را ببینید.' },
  '/hetzner': { title: 'خرید سرور هتزنر | قیمت سرور ساعتی و ماهانه - پارس سرور', description: 'راهنمای انتخاب سرور ارزان هتزنر بر اساس نیاز واقعی؛ مقایسهٔ پلن‌های قابل سفارش، موقعیت، CPU، RAM، دیسک، ترافیک و قیمت تومانی ساعتی و ماهانه.' },
} as const
export type PublicPath = keyof typeof publicPages
export const isPublicPath = (path: string): path is PublicPath => Object.hasOwn(publicPages, path)
export const shareImage = PUBLIC_ORIGIN + '/parserver-share.png'
