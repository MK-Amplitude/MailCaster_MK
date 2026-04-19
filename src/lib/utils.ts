import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format, formatDistanceToNow } from 'date-fns'
import { ko } from 'date-fns/locale'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return '-'
  return format(new Date(date), 'yyyy.MM.dd', { locale: ko })
}

export function formatDateTime(date: string | Date | null | undefined): string {
  if (!date) return '-'
  return format(new Date(date), 'yyyy.MM.dd HH:mm', { locale: ko })
}

export function formatRelative(date: string | Date | null | undefined): string {
  if (!date) return '-'
  return formatDistanceToNow(new Date(date), { addSuffix: true, locale: ko })
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength) + '...'
}

/** 바이트를 사람이 읽기 쉬운 단위로 (1024 기반) */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '-'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const v = bytes / Math.pow(1024, i)
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Gmail 첨부 한도 — 총 메시지(헤더+첨부 base64 포함) 25MB.
 *  Base64 인코딩은 원본 대비 ~33% 증가 → 원본 18MB 면 base64 24MB + 헤더/본문 오버헤드 < 25MB.
 *  20MB 원본은 base64 26.6MB 로 즉시 초과하므로 위험. 18MB 로 안전 마진 확보. */
export const GMAIL_ATTACHMENT_LIMIT = 25 * 1024 * 1024
export const GMAIL_ATTACHMENT_SAFE_THRESHOLD = 18 * 1024 * 1024
