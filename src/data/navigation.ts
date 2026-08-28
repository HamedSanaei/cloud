import {
  Box,
  CircleDollarSign,
  FileText,
  Gauge,
  Globe2,
  HardDrive,
  LifeBuoy,
  Network,
  Package,
  ReceiptText,
  Settings,
  ShieldCheck,
  UserRound,
  WalletCards,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  label: string
  path: string
  icon: LucideIcon
  keywords?: string[]
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
  {
    label: 'ناحیه کاربری',
    items: [
      { label: 'داشبورد', path: '/dashboard', icon: Gauge, keywords: ['خانه', 'آمار'] },
      { label: 'تیکت‌ها', path: '/tickets', icon: LifeBuoy, keywords: ['پشتیبانی'] },
    ],
  },
  {
    label: 'مالی',
    items: [
      { label: 'کیف پول', path: '/wallet', icon: WalletCards, keywords: ['موجودی', 'شارژ'] },
      { label: 'فاکتورها', path: '/invoices', icon: FileText, keywords: ['صورتحساب'] },
      { label: 'درخواست‌های شارژ', path: '/charge-requests', icon: ReceiptText, keywords: ['واریز'] },
    ],
  },
  {
    label: 'زیرساخت',
    items: [
      { label: 'سرورها', path: '/servers', icon: HardDrive, keywords: ['ابر', 'ماشین مجازی'] },
      { label: 'آی‌پی‌ها', path: '/ips', icon: Globe2, keywords: ['IPv4', 'IPv6'] },
      { label: 'بسته ترافیک', path: '/traffic-packages', icon: Box, keywords: ['پهنای باند'] },
      { label: 'دامنه‌ها', path: '/domains', icon: Network, keywords: ['ثبت دامنه'] },
    ],
  },
]

export const accountLinks: NavItem[] = [
  { label: 'پروفایل', path: '/profile/update', icon: UserRound },
  { label: 'نشست‌ها', path: '/sessions', icon: ShieldCheck },
  { label: 'تنظیمات', path: '/settings', icon: Settings },
]

export const allSearchItems = [
  ...navGroups.flatMap((group) => group.items),
  ...accountLinks,
  { label: 'ایجاد سرور جدید', path: '/servers/create', icon: Package, keywords: ['خرید سرور'] },
  { label: 'ثبت دامنه جدید', path: '/domains/register', icon: Network, keywords: ['خرید دامنه'] },
  { label: 'تغییرات نسخه', path: '/changelog', icon: CircleDollarSign, keywords: ['نسخه'] },
]
